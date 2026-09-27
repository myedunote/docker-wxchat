#!/usr/bin/env node
/**
 * 优雅关闭回归测试
 * ============================================================
 * 背景：用户报告「容器启动后不久就停止」，日志末尾是
 *   `收到 SIGTERM，开始优雅关闭…` → `✓ 数据库已安全关闭` → `✓ 已退出`
 *
 * 这说明 SIGTERM 是**外部**发来的、且应用把关闭流程完整走完了。
 * 但这条链路此前没有任何自动化断言 —— 一旦有人改动 shutdown()，
 * 表现会退化成「被 SIGTERM 后卡住 10 秒再被强杀」（退出码 137），
 * 而日志看起来仍然「像正常关闭」，极难发现。
 *
 * 本脚本用**真实信号**验证（不是 process.emit 之类的模拟）：
 *   正向：SIGTERM → 打印关闭日志 → 退出码 0
 *   反向：SIGKILL → 不打印任何关闭日志 → 退出码非 0
 * 反向对照是必须的：没有它，「正向断言通过」可能只是因为断言写成了空条件。
 *
 * ⚠ 平台限制：Windows 没有 POSIX 信号，Node 的 child.kill('SIGTERM')
 *   在 Windows 上是**强制终止**，根本不会走信号处理器。因此本脚本在
 *   Windows 上显式跳过（并说明原因），请在 Linux / macOS 上运行 ——
 *   CI 跑在 ubuntu-latest 上，会自动覆盖这一项。
 *
 * 用法：node scripts/check-shutdown.js
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

if (process.platform === 'win32') {
  console.log('⚠ 跳过：当前平台是 Windows。');
  console.log('  Node 在 Windows 上没有 POSIX 信号 —— child.kill(\'SIGTERM\') 是强制终止，');
  console.log('  不会触发信号处理器，测不出任何东西。请在 Linux / macOS 上运行');
  console.log('  （CI 的 verify 任务跑在 ubuntu-latest，会覆盖这一项）。');
  process.exit(0);
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

/** 起一个真实的 src/server.js 子进程，把 stdout/stderr 收进 state.out */
function startServer({ port, dataDir }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      // 显式传入的变量优先于 .env —— loadDotEnv 只填补 process.env 里没有的键
      ACCESS_PASSWORD: 'shutdown-test-password',
      JWT_SECRET: 'shutdown-test-secret-0123456789abcdef',
      DATABASE_PATH: join(dataDir, 'wxchat.db'),
      UPLOAD_PATH: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, out: '', exited: false };
  child.stdout.on('data', (d) => { state.out += d.toString(); });
  child.stderr.on('data', (d) => { state.out += d.toString(); });
  child.once('exit', () => { state.exited = true; });
  return state;
}

/** 轮询等待日志里出现某个片段；子进程提前退出则立刻返回 false */
function waitForLog(state, needle, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (state.out.includes(needle)) { clearInterval(iv); resolve(true); return; }
      if (state.exited) { clearInterval(iv); resolve(false); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 50);
  });
}

function waitExit(state, timeoutMs) {
  return new Promise((resolve) => {
    if (state.exited) { resolve({ code: state.child.exitCode, signal: state.child.signalCode }); return; }
    const t = setTimeout(() => resolve(null), timeoutMs);
    state.child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

// 硬超时：任何一步卡住都不该让 CI 一直挂着。
// 刻意不 unref —— 它必须能真的把进程叫停。
const HARD_TIMEOUT = setTimeout(() => {
  console.error('\n✗ 硬超时（60 秒），测试流程卡住了。');
  process.exit(1);
}, 60_000);

const tmp = mkdtempSync(join(tmpdir(), 'wxchat-shutdown-'));

async function main() {
  // ==========================================================
  console.log('\n[1] 正向：SIGTERM 应触发完整优雅关闭，并以 0 退出');
  // ==========================================================
  const a = startServer({ port: 3199, dataDir: tmp });

  const started = await waitForLog(a, '✓ 服务已启动', 30_000);
  ok('子进程启动并监听成功', started, a.out.slice(-400) || '(无输出)');
  if (!started) {
    a.child.kill('SIGKILL');
    return;
  }

  // 启动横幅里新增的两行：OOM 是 SIGKILL、不留日志，这两行是唯一的线索
  ok('启动横幅打印了容器内存上限', a.out.includes('容器内存上限'));
  ok('启动横幅打印了 Node 堆上限', a.out.includes('Node 堆上限'));

  a.child.kill('SIGTERM');
  const exitA = await waitExit(a, 20_000);

  ok('收到 SIGTERM 后进程确实退出了', exitA !== null, '等待 20 秒仍未退出（关闭流程卡住）');
  if (exitA) {
    ok('退出码为 0（正常关闭，不是被强杀）', exitA.code === 0,
      `实际 code=${exitA.code} signal=${exitA.signal}`);
    ok('日志包含「收到 SIGTERM，开始优雅关闭」', a.out.includes('收到 SIGTERM，开始优雅关闭'));
    ok('日志包含「本次已运行」（新增的运行时长）', a.out.includes('本次已运行'));
    ok('日志包含「✓ 数据库已安全关闭」', a.out.includes('✓ 数据库已安全关闭'));
    ok('日志包含「✓ 已退出」', a.out.includes('✓ 已退出'));
    ok('没有走到「关闭超时，强制退出」',
      !a.out.includes('关闭超时，强制退出'));
    // 顺序：信号 → 数据库关闭 → 退出
    const iSig = a.out.indexOf('收到 SIGTERM');
    const iDb = a.out.indexOf('✓ 数据库已安全关闭');
    const iEnd = a.out.indexOf('✓ 已退出');
    ok('关闭步骤顺序正确（信号 → 关库 → 退出）',
      iSig !== -1 && iDb > iSig && iEnd > iDb,
      `index: sig=${iSig} db=${iDb} end=${iEnd}`);
  }

  // ==========================================================
  console.log('\n[2] 反向对照：SIGKILL 不该产生任何「优雅关闭」日志');
  // ==========================================================
  // 没有这一节，上面所有断言都可能是空条件 ——
  // 比如「日志包含 ✓ 已退出」在进程根本没收到信号时也可能因为别的原因通过。
  const b = startServer({ port: 3200, dataDir: tmp });
  const startedB = await waitForLog(b, '✓ 服务已启动', 30_000);
  ok('反向对照组：子进程启动成功', startedB);
  if (startedB) {
    b.child.kill('SIGKILL');
    const exitB = await waitExit(b, 20_000);
    ok('SIGKILL 后进程退出', exitB !== null);
    ok('未出现「收到 SIGTERM」日志（证明正向断言不是空条件）',
      !b.out.includes('收到 SIGTERM'));
    ok('未出现「✓ 已退出」日志（SIGKILL 不可捕获，来不及清理）',
      !b.out.includes('✓ 已退出'));
    if (exitB) {
      ok('退出码非 0（被强杀，与正向的 0 形成对照）', exitB.code !== 0,
        `实际 code=${exitB.code} signal=${exitB.signal}`);
    }
  }

  // 兜底：确保没有残留进程占着端口
  for (const s of [a, b]) {
    if (!s.exited) s.child.kill('SIGKILL');
  }
}

main()
  .catch((err) => {
    fail += 1;
    console.error('  ✗ 测试脚本自身抛错:', err?.stack || err);
  })
  .finally(async () => {
    // 留一点时间让兜底的 SIGKILL 生效，避免端口占用泄漏到后续步骤
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    clearTimeout(HARD_TIMEOUT);

    console.log(`\n${'='.repeat(62)}`);
    console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
    console.log('='.repeat(62));
    process.exit(fail ? 1 : 0);
  });
