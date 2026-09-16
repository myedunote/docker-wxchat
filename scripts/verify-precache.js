/**
 * 构建期校验：public/sw.js 的 PRECACHE 列表里每个文件都必须真的在镜像里。
 *
 * 为什么需要它：
 *   Dockerfile 的构建期断言目前只检查 4 个入口文件（server.js / package.json /
 *   schema.sql / index.html）。只要 index.html 在，就算 public/ 只被复制了一部分，
 *   构建也会成功 —— 直到用户打开页面才发现样式或脚本 404。
 *
 *   而 PRECACHE 恰好是一份现成的「前端必须存在的资源清单」，拿它当 manifest
 *   来校验，等于免费获得一次全量资源存在性检查。
 *
 * 用法（Dockerfile 里在 COPY 之后调用）：
 *   RUN node scripts/verify-precache.js
 * 也可本地直接跑：node scripts/verify-precache.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const SW_PATH = join(PUBLIC_DIR, 'sw.js');

if (!existsSync(SW_PATH)) {
  console.error(`构建失败：找不到 ${SW_PATH}`);
  process.exit(1);
}

const sw = readFileSync(SW_PATH, 'utf8');
const precache = [...sw.matchAll(/^\s*'(\/[^']+)'/gm)].map((m) => m[1]);

if (precache.length === 0) {
  console.error('构建失败：无法从 sw.js 解析出 PRECACHE 列表（格式是否被改动了？）');
  process.exit(1);
}

const missing = [];
for (const p of precache) {
  // '/' 是首页路由，不是文件；其余按 public/ 下的相对路径找
  if (p === '/') continue;
  const target = join(PUBLIC_DIR, p.replace(/^\//, ''));
  if (!existsSync(target)) missing.push(`${p}  →  期望 ${target}`);
}

if (missing.length) {
  console.error('构建失败：PRECACHE 中以下文件不在镜像里：');
  missing.forEach((m) => console.error(`  - ${m}`));
  console.error('请检查 Dockerfile 的 COPY 指令与 .dockerignore 是否误伤了 public/ 的子目录。');
  process.exit(1);
}

console.log(`✓ PRECACHE 的 ${precache.length} 项资源全部存在于镜像内`);
