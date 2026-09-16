#!/usr/bin/env node
/**
 * .env 体检 —— 在部署之前回答一个问题：
 *   「这个 .env 里的值，实际会以什么内容传进容器？」
 *
 * 背景：compose 的 env_file 不是原样透传。它会剥引号、忽略值前后空格、
 * 按 `#` 截断行内注释，并对**未加引号/双引号**的值做 `$` 变量插值。
 * 密码类变量一旦被插值或截断，服务端只会回一句「密码错误」，
 * 而日志里看不出任何异常 —— 这类事故的排查成本极高。
 *
 * 用法：
 *   node scripts/check-env-file.mjs              # 体检 ./.env
 *   node scripts/check-env-file.mjs path/to/.env
 *   node scripts/check-env-file.mjs --selftest   # 只跑解析器自检
 *
 * 退出码：0 = 无高危差异；1 = 有密钥类变量会被改变
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEnvContent, runSelfTest, DOC_EXAMPLES } from './lib/compose-env.js';

/**
 * 密钥类变量：这些值哪怕只差一个字符，功能就是直接坏掉（登录失败 / 401），
 * 而且服务端不会给出任何指向配置的线索。所以它们一旦有差异，必须让脚本失败退出。
 */
const SECRET_KEYS = new Set([
  'ACCESS_PASSWORD',
  'JWT_SECRET',
  'CLEAR_CONFIRM_CODE',
  'AI_API_KEY',
  'IMAGE_GEN_API_KEY',
  'AI_CHAT_API_KEY',
  'IMAGE_GEN_API_KEY',
]);

/** 明显是占位符的值，直接点出来 */
const PLACEHOLDERS = new Set([
  'change-me-please',
  'change-me-to-a-random-long-secret',
  'your-password',
  'password',
  'changeme',
]);

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

/** 把不可见字符显形，便于用户看出「长度为什么不一样」 */
function visible(s) {
  return s
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** 只用于密钥类变量的「形状描述」，绝不回显内容 */
function describeShape(value) {
  const parts = [];
  if (value.length === 0) return '（空）';
  if (value !== value.trim()) parts.push('首尾有空格');
  if (/\s/.test(value)) parts.push('中间含空白');
  if (value.includes('$')) parts.push('含 $');
  if (value.includes('#')) parts.push('含 #');
  if (value.includes('"') || value.includes("'")) parts.push('含引号');
  if (/[\u0000-\u001f]/.test(value)) parts.push('含控制字符');
  if (/[^\x20-\x7e]/.test(value)) parts.push('含非 ASCII 字符');
  return parts.length ? parts.join('、') : '纯可见 ASCII';
}

function main() {
  const args = process.argv.slice(2);
  const onlySelfTest = args.includes('--selftest');
  const showAll = args.includes('--all');

  // —— 0. 先自检解析器 ——
  // 体检结论完全建立在这个解析器上，所以先证明它与官方文档一致，
  // 否则「没发现问题」这个结论本身是不可信的。
  const failures = runSelfTest();
  console.log(c(C.bold, 'docker-wxchat · .env 体检'));
  console.log(
    `解析器自检：${c(failures.length ? C.red : C.green, `${DOC_EXAMPLES.length - failures.length}/${DOC_EXAMPLES.length}`)}` +
    ` 项官方示例断言通过`
  );
  if (failures.length) {
    console.log(c(C.red, '\n解析器与官方文档不一致，体检结论不可信：'));
    for (const f of failures) {
      console.log(`  ✗ ${f.name}：${JSON.stringify(f.line)} 期望 ${JSON.stringify(f.expect)}，实际 ${JSON.stringify(f.got)}`);
    }
    process.exit(2);
  }
  if (onlySelfTest) process.exit(0);

  // —— 1. 定位文件 ——
  const target = args.find((a) => !a.startsWith('--')) || '.env';
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    console.log(c(C.yellow, `\n找不到 ${filePath}`));
    console.log('说明：容器镜像里不含 .env（由 compose 的 env_file 在运行时注入）。');
    console.log('      本脚本应在**宿主机**上、与 docker-compose.yml 同级的目录里运行。');
    process.exit(0);
  }
  console.log(`文件：${filePath}`);

  const content = fs.readFileSync(filePath, 'utf8');
  const { entries, order, warnings } = parseEnvContent(content);

  // —— 2. 逐项比对 ——
  const problems = [];
  const notices = [];
  const okSecrets = [];

  for (const key of order) {
    const e = entries.get(key);
    if (!e) continue;
    const changed = e.actual !== e.intended;
    const isSecret = SECRET_KEYS.has(key);

    if (isSecret && PLACEHOLDERS.has(e.actual)) {
      notices.push({
        key,
        lines: [
          `仍是示例占位值 ${JSON.stringify(e.actual)}，上线前必须改掉。`,
        ],
      });
    }

    // 空值不会触发「值被改写」告警，但后果更严重，单独点名
    if (key === 'ACCESS_PASSWORD' && e.actual === '') {
      notices.push({
        key,
        lines: ['值为空 —— 服务端会拒绝一切登录，启动日志会打印「未设置 ACCESS_PASSWORD」。'],
      });
    }
    if (key === 'JWT_SECRET' && e.actual === '') {
      notices.push({
        key,
        lines: ['值为空 —— 服务端会退回到内置的不安全默认密钥，生产环境必须设置。'],
      });
    }

    if (changed) {
      const lines = [];
      lines.push(
        `文件里看起来是 : ${e.intended.length} 个字符 ${isSecret ? '' : `→ ${JSON.stringify(visible(e.intended))}`}`
      );
      lines.push(
        `实际传入容器是 : ${e.actual.length} 个字符 ${isSecret ? '' : `→ ${JSON.stringify(visible(e.actual))}`}`
      );
      for (const r of e.reasons) {
        lines.push(`原因           : ${r.text}`);
        lines.push(`修正           : ${r.fix}`);
      }
      problems.push({ key, isSecret, lines });
    } else if (isSecret) {
      okSecrets.push({ key, e });
    }
  }

  // —— 3. 输出 ——
  const secretProblems = problems.filter((p) => p.isSecret);
  const otherProblems = problems.filter((p) => !p.isSecret);

  console.log('');
  if (secretProblems.length) {
    console.log(c(C.bold + C.red, '【高危】以下密钥类变量传进容器的值与你写的不一样：'));
    for (const p of secretProblems) {
      console.log(c(C.red, `  ✗ ${p.key}`));
      for (const l of p.lines) console.log(`      ${l}`);
      console.log('');
    }
  }

  if (otherProblems.length) {
    const list = showAll ? otherProblems : otherProblems.slice(0, 8);
    console.log(c(C.bold + C.yellow, '【提醒】以下变量传进容器的值有变化（非密钥类，一般不影响功能）：'));
    for (const p of list) {
      console.log(c(C.yellow, `  ⚠ ${p.key}`));
      for (const l of p.lines) console.log(`      ${l}`);
    }
    if (list.length < otherProblems.length) {
      console.log(c(C.dim, `  …还有 ${otherProblems.length - list.length} 项，用 --all 全部显示`));
    }
    console.log('');
  }

  if (notices.length) {
    console.log(c(C.bold + C.yellow, '【注意】'));
    for (const n of notices) {
      console.log(c(C.yellow, `  ! ${n.key}`));
      for (const l of n.lines) console.log(`      ${l}`);
    }
    console.log('');
  }

  for (const w of warnings) console.log(c(C.yellow, `  ⚠ ${w}`));

  if (!secretProblems.length && !otherProblems.length && !notices.length) {
    console.log(c(C.green, '✓ 全部变量的取值与文件内容一致，没有会被 compose 改写的地方。'));
    console.log('');
  }

  // 密钥类变量即使「一致」也把长度报出来 —— 这是和容器内启动日志对账用的凭据
  if (okSecrets.length) {
    console.log(c(C.bold, '【对账用】密钥类变量在容器内应有的长度（与启动日志比对）：'));
    for (const { key, e } of okSecrets) {
      console.log(`  ${c(C.green, '✓')} ${key.padEnd(22)} 长度 ${String(e.actual.length).padStart(3)}   形状 ${describeShape(e.actual)}`);
    }
    console.log('');
    console.log(c(C.dim, '  在容器里执行以下命令，看到的长度应与此一致：'));
    console.log(c(C.dim, '    docker compose exec wxchat node scripts/diagnose-login.mjs'));
    console.log('');
  }

  process.exit(secretProblems.length ? 1 : 0);
}

main();
