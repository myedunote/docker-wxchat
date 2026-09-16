#!/usr/bin/env node
/**
 * 登录链路一键诊断（在容器内运行）
 * ============================================================
 * 「输入了 ACCESS_PASSWORD 里设的密码，却提示密码错误」这个现象，
 * 可能的成因有好几种，而且它们在日志里长得一模一样：
 *
 *   A. .env 里的密码被 compose 改写（未加引号时 $ 被插值、` #` 被截断）
 *   B. 改了 .env 却没重建容器（只 `restart` 不会重新读取 env_file）
 *   C. 浏览器自动填充/密码管理器塞进了旧密码
 *   D. 连续失败太多次，IP 被临时锁定
 *
 * 本脚本用「二分法」把它们区分开：
 *   用**容器自己拿到的那个密码**去请求登录接口。
 *     - 成功  → 服务端配置没问题，问题在客户端（C）
 *     - 失败  → 容器里的值本身就是错的（A / B）
 *     - 被锁定 → D
 *
 * 用法（宿主机上执行）：
 *   docker compose exec wxchat node scripts/diagnose-login.mjs
 *   docker compose exec wxchat node scripts/diagnose-login.mjs --reset-lock
 *
 * 也可以传入一个你想验证的密码：
 *   docker compose exec wxchat node scripts/diagnose-login.mjs --try '你的密码'
 */

import { describeSecret } from '../src/adapter/env.js';

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

const argv = process.argv.slice(2);
const resetLock = argv.includes('--reset-lock');
const tryIdx = argv.indexOf('--try');
const tryPassword = tryIdx !== -1 ? argv[tryIdx + 1] : null;

const PORT = process.env.PORT || '3000';
const BASE = process.env.WXCHAT_BASE || `http://127.0.0.1:${PORT}`;

/** 结果标记，便于一眼扫到结论 */
const OK = () => c(C.green, '✓');
const BAD = () => c(C.red, '✗');
const WARN = () => c(C.yellow, '!');

async function postLogin(password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应（例如 SPA fallback 返回的 HTML） */
  }
  return { status: res.status, body };
}

/** 直接读 SQLite 看锁定状态；没有 better-sqlite3 时安静跳过 */
async function readAttempts(doReset = false) {
  const dbPath = process.env.DATABASE_PATH || '/app/data/wxchat.db';
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: !doReset });
    const rows = db.prepare('SELECT ip, fail_count, locked_until, updated_at FROM login_attempts').all();
    if (doReset) {
      const info = db.prepare('DELETE FROM login_attempts').run();
      db.close();
      return { rows, cleared: info.changes, dbPath };
    }
    db.close();
    return { rows, dbPath };
  } catch (err) {
    return { error: err.message, dbPath };
  }
}

async function main() {
  console.log(c(C.bold, 'docker-wxchat · 登录链路诊断'));
  console.log(`目标服务：${BASE}`);
  console.log(`数据库  ：${process.env.DATABASE_PATH || '/app/data/wxchat.db'}`);
  console.log('');

  // —— 1. 容器实际拿到的值 ——
  const containerPassword = process.env.ACCESS_PASSWORD || '';
  console.log(c(C.bold, '[1] 容器里实际拿到的 ACCESS_PASSWORD'));
  console.log(`    ${describeSecret(containerPassword)}`);
  if (!containerPassword) {
    console.log(`    ${BAD()} 值为空 —— 服务端会拒绝一切登录。`);
    console.log('        请在 .env 里配置，然后 `docker compose up -d` 重建容器。');
    process.exit(1);
  }
  if (containerPassword.includes('$') || containerPassword.includes('#')) {
    console.log(
      `    ${WARN()} 值里含 $ 或 #。compose 对未加引号的值会做插值 / 截断行内注释，\n` +
      '        请在**宿主机**上执行 `npm run check:env` 核对传入容器后是否仍是你要的值。'
    );
  }
  console.log('');

  // —— 1.5 先解锁（如果要求）——
  // 必须放在「请求登录接口」之前：否则那次探测会先撞上锁定，
  // 结论里就会残留一条已经不成立的「被锁定」，把用户又绕回原点。
  let earlyReset = null;
  if (resetLock) {
    console.log(c(C.bold, '[1.5] 清除登录失败记录'));
    earlyReset = await readAttempts(true);
    if (earlyReset.error) {
      console.log(`    ${BAD()} 无法写入数据库：${earlyReset.error}`);
      console.log(`        可手动执行： sqlite3 ${earlyReset.dbPath} "DELETE FROM login_attempts;"`);
    } else {
      console.log(`    ${OK()} 已清空 ${earlyReset.cleared} 条记录（${earlyReset.dbPath}）`);
    }
    console.log('');
  }

  // —— 2. 用容器自己的值请求登录 ——
  console.log(c(C.bold, '[2] 用容器自己的值请求登录接口'));
  let verdict = null;
  try {
    const r = await postLogin(containerPassword);
    if (r.status === 200 && r.body.success) {
      console.log(`    ${OK()} 登录成功。`);
      verdict = 'server-ok';
    } else if (r.body.code === 'LOGIN_LOCKED') {
      console.log(`    ${WARN()} ${r.body.error}`);
      verdict = 'locked';
    } else if (r.body.code === 'CONFIG_ERROR') {
      console.log(`    ${BAD()} ${r.body.error}`);
      verdict = 'no-password';
    } else {
      console.log(`    ${BAD()} HTTP ${r.status} ${JSON.stringify(r.body)}`);
      verdict = 'server-bad';
    }
  } catch (err) {
    console.log(`    ${BAD()} 请求失败：${err.message}`);
    console.log(`        确认服务在 ${BASE} 上监听（容器内端口应为 3000）。`);
    verdict = 'unreachable';
  }
  console.log('');

  // —— 3. 可选：验证用户心里那个密码 ——
  if (tryPassword) {
    console.log(c(C.bold, '[3] 用你指定的密码请求登录接口'));
    console.log(`    你给的密码长度 ${tryPassword.length}，容器里的值长度 ${containerPassword.length}`);
    try {
      const r = await postLogin(tryPassword);
      if (r.status === 200 && r.body.success) {
        console.log(`    ${OK()} 这个密码是对的。`);
      } else {
        console.log(`    ${BAD()} 这个密码不对：HTTP ${r.status} ${JSON.stringify(r.body)}`);
        if (tryPassword.length !== containerPassword.length) {
          console.log(
            `    ${WARN()} 两者长度不同 —— 这正是「.env 里的值被 compose 改写」\n` +
            '        或「改了 .env 但容器没重建」的典型特征。\n' +
            '        在宿主机上跑 `npm run check:env` 可以直接看出被改写成了什么。'
          );
        } else {
          console.log(`    ${WARN()} 长度相同但内容不同 —— 检查大小写、首尾空格。`);
        }
      }
    } catch (err) {
      console.log(`    ${BAD()} 请求失败：${err.message}`);
    }
    console.log('');
  }

  // —— 4. 锁定状态 ——
  console.log(c(C.bold, '[4] 登录失败计数 / 锁定状态'));
  if (earlyReset && !earlyReset.error) {
    console.log(`    ${OK()} 已在 [1.5] 清除 ${earlyReset.cleared} 条失败记录`);
  }
  const att = await readAttempts();
  if (att.error) {
    console.log(`    ${c(C.dim, `无法直接读取数据库（${att.error}），跳过`)}`);
  } else if (!att.rows.length) {
    console.log(`    ${OK()} 没有任何失败记录`);
  } else {
    for (const row of att.rows) {
      const locked = row.locked_until && Date.parse(`${row.locked_until}Z`) > Date.now();
      const flag = locked ? c(C.red, '已锁定') : c(C.dim, '未锁定');
      console.log(`    ip=${row.ip}  失败 ${row.fail_count} 次  ${flag}${row.locked_until ? `  解锁于 ${row.locked_until} (UTC)` : ''}`);
    }
    if (att.rows.some((r) => r.ip === 'unknown')) {
      console.log(
        `    ${WARN()} 出现了 ip=unknown 的记录：请求没有带上 X-Forwarded-For / CF-Connecting-IP，\n` +
        '        所有客户端会共用同一个失败计数桶 —— 一个人连续输错就可能把所有人锁在门外。\n' +
        '        反向代理请补上 X-Forwarded-For。'
      );
    }
    console.log(`    ${c(C.dim, '用 --reset-lock 可立即清除全部失败记录与锁定')}`);
  }
  console.log('');

  // —— 5. 结论 ——
  console.log(c(C.bold, '结论'));
  if (verdict === 'server-ok') {
    console.log(
      `  ${OK()} 服务端配置正确：容器里的密码能通过登录接口。\n` +
      '     那么问题出在浏览器侧。请依次排查：\n' +
      '       1) 点登录框旁的「显示」按钮，肉眼确认里面到底是什么（浏览器自动填充很常见）\n' +
      '       2) 用无痕窗口打开登录页再试一次（排除自动填充与旧缓存）\n' +
      '       3) 确认访问的是这台服务，而不是别的地址'
    );
  } else if (verdict === 'server-bad') {
    console.log(
      `  ${BAD()} 容器里的密码本身就是错的 —— 与你在浏览器里输入什么无关。\n` +
      '     这是最常见的两种情况：\n' +
      '       A) .env 里的值被 compose 改写（未加引号时 $ 会被插值、` #` 会被截断）\n' +
      '          在宿主机执行 `npm run check:env` 可直接看到改写结果\n' +
      '       B) 改了 .env 却没重建容器（只 `restart` 不会重新读取 env_file）\n' +
      '          执行 `docker compose up -d --force-recreate` 后重试'
    );
  } else if (verdict === 'locked') {
    console.log(
      `  ${WARN()} 当前 IP 被临时锁定。执行下面这条即可立即解锁：\n` +
      '       docker compose exec wxchat node scripts/diagnose-login.mjs --reset-lock\n' +
      '     或者等锁定时长（.env 的 LOGIN_LOCKOUT_MINUTES，默认 15 分钟）过去。'
    );
  } else if (verdict === 'no-password') {
    console.log(`  ${BAD()} 服务端没有拿到 ACCESS_PASSWORD。检查 compose 的 env_file 是否指向了正确的 .env。`);
  } else {
    console.log(`  ${BAD()} 无法连接服务，先确认容器在运行、端口正确。`);
  }
}

main().catch((err) => {
  console.error('诊断脚本自身异常：', err);
  process.exit(2);
});
