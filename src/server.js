/**
 * docker-wxchat 服务端入口
 *
 * 职责（顺序很重要）：
 *   1. 读取 .env（可选）与 process.env
 *   2. 准备数据目录 / 上传目录（volume 挂载点）
 *   3. 打开 SQLite（better-sqlite3）并幂等执行 database/schema.sql
 *   4. 构造 R2 / ASSETS 适配器，组装出 worker 期望的 env
 *   5. 挂载 Hono 应用并监听 PORT
 *   6. 注册优雅关闭
 *
 * 关于历史坑：旧项目镜像里的 CMD 写成了 `node /server.js`，
 * 在 WORKDIR 未生效时会去文件系统根目录找 /server.js，直接 MODULE_NOT_FOUND。
 * 本项目：
 *   - Dockerfile 固定 WORKDIR /app
 *   - CMD 为 ["node", "src/server.js"]（相对路径，由 Node 基于 cwd 解析）
 *   - 启动时主动打印 cwd 与入口绝对路径，便于一眼定位问题
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { createApp } from './worker/index.js';
import { createD1 } from './adapter/d1.js';
import { createR2 } from './adapter/r2.js';
import { createAssets } from './adapter/assets.js';
import {
  createEnv, loadDotEnv, parseIntEnv,
  findSuspiciousEnvKeys, formatSecuritySection,
} from './adapter/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** 仓库根目录（src/ 的上一级） */
const ROOT_DIR = path.resolve(__dirname, '..');

const VERSION = '2.0.1';

function log(...args) {
  console.log('[wxchat]', ...args);
}

function fatal(message, err) {
  console.error('[wxchat] ✗', message, err ? `\n${err.stack || err}` : '');
  process.exit(1);
}

/** 启动自检：把「容器里到底在哪个目录、入口文件在哪」直接打到日志里 */
function printEnvironmentBanner({ dbPath, uploadPath, publicDir }) {
  log('==================== docker-wxchat ====================');
  log(`版本          : ${VERSION}`);
  log(`Node 版本     : ${process.version}`);
  log(`工作目录 cwd  : ${process.cwd()}`);
  log(`入口文件      : ${__filename}`);
  log(`数据库文件    : ${dbPath}`);
  log(`上传目录      : ${uploadPath}`);
  log(`静态资源目录  : ${publicDir}`);
  log(`时区 TZ       : ${process.env.TZ || '(未设置，使用系统默认)'}`);
  log('=======================================================');
}

/** 采集目录/进程的身份与权限信息，用于在启动失败时给出可直接照做的诊断 */
function describeDir(dir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '(该平台无此接口)';
  const gid = typeof process.getgid === 'function' ? process.getgid() : '(该平台无此接口)';
  const lines = [`  当前进程 uid:gid : ${uid}:${gid}`];
  try {
    const st = fs.statSync(dir);
    const mode = (st.mode & 0o7777).toString(8).padStart(3, '0');
    lines.push(`  目录属主 uid:gid : ${st.uid}:${st.gid}`);
    lines.push(`  目录权限         : ${mode}`);
  } catch (err) {
    lines.push(`  目录状态         : 无法 stat（${err.code || err.message}）`);
  }
  return lines.join('\n');
}

/** 目录不可写时的处置建议（按真实出现频率排序） */
const PERM_HINTS = [
  '  1) 宿主机目录不属于容器运行身份（最常见）',
  '       sudo chown -R 1000:1000 ./data ./uploads',
  '     或让容器以宿主机目录属主身份运行，写进 .env：',
  '       PUID=<目录属主 uid>',
  '       PGID=<目录属主 gid>',
  "     查宿主机目录属主： stat -c '%u:%g' ./data",
  '',
  '  2) 宿主机启用了 SELinux（Fedora / CentOS / RHEL / openEuler / Anolis 等）',
  '     给 bind mount 加标签，把 compose 里的挂载改成：',
  '       - ./data:/app/data:Z',
  '',
  '  3) 改用命名卷替代 bind mount（最省事，不会有属主问题）',
  '       volumes:',
  '         - wxchat-data:/app/data',
  '     命名卷首次创建时会继承镜像里 /app/data 的属主（node:node）。',
  '',
  '  4) NAS / 面板部署（群晖、威联通、1Panel 等）',
  '     这些工具会重写卷与权限设置，请确认映射到的共享文件夹',
  '     对运行身份可读写，并检查共享文件夹 ACL。',
].join('\n');

/**
 * 确保目录存在、确实是目录、并且**真的可写**。
 *
 * 为什么不能只用 mkdir：
 *   fs.mkdirSync(dir, { recursive: true }) 在目录**已存在**时会静默成功，
 *   哪怕这个目录对当前用户只读。于是启动检查一路放行，直到
 *   `new Database(file)` 才失败，暴露出来的是极难定位的
 *   `SqliteError: unable to open database file`（SQLITE_CANTOPEN）——
 *   它不会告诉你到底是权限问题、路径问题还是挂载问题。
 *
 * 这里改成实际写一个探针文件，把「不可写」提前变成一条能直接照做的错误。
 */
function ensureWritableDir(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fatal(
      `${label}无法创建：${dir}\n  ${err.code || ''} ${err.message}\n\n` +
      `诊断信息：\n${describeDir(dir)}\n\n处置建议：\n${PERM_HINTS}`
    );
  }

  let st;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    fatal(
      `${label}无法访问：${dir}\n  ${err.code || ''} ${err.message}\n\n` +
      `诊断信息：\n${describeDir(dir)}`
    );
  }
  if (!st.isDirectory()) {
    fatal(
      `${label}不是一个目录：${dir}\n` +
      `  它当前是一个文件。请检查 compose 里 volume 映射是否写错。`
    );
  }

  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, `ok pid=${process.pid} at=${new Date().toISOString()}\n`);
  } catch (err) {
    fatal(
      `${label}不可写：${dir}\n` +
      `  ${err.code || ''} ${err.message}\n\n` +
      `诊断信息：\n${describeDir(dir)}\n\n` +
      `处置建议：\n${PERM_HINTS}`
    );
  }
  // 探针删不掉不影响「可写」这个结论：
  // 某些受限环境允许写但拒绝删，那种情况下服务依然应该正常启动。
  try {
    fs.unlinkSync(probe);
  } catch {
    /* 忽略 */
  }

  log(`✓ ${label}可写: ${dir}`);
}

/**
 * 复现验收红线里的那条检查：
 *   node -e "require('fs').accessSync(process.cwd()+'/package.json')"
 * 在启动阶段直接跑一遍，失败就立刻退出，而不是等到运行时才发现工作目录不对。
 */
function assertCwdIsProjectRoot() {
  const pkg = path.join(process.cwd(), 'package.json');
  try {
    fs.accessSync(pkg, fs.constants.R_OK);
  } catch {
    fatal(
      `工作目录不正确：${pkg} 不存在。\n` +
      `请确认容器 WORKDIR 为 /app 且以 "node src/server.js" 启动（不要用绝对路径 /server.js）。`
    );
  }
  return pkg;
}

/** 幂等执行 schema.sql。全部是 CREATE TABLE IF NOT EXISTS，可重复启动 */
async function initSchema(db, schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    fatal(`找不到 schema 文件: ${schemaPath}`);
  }
  const sql = await fsp.readFile(schemaPath, 'utf8');
  db.exec(sql);
  return true;
}

async function main() {
  // 1. 载入 .env（仅本地/首次启动便利；容器里由 compose env_file 提供）
  const dotenvPath = path.join(ROOT_DIR, '.env');
  const loaded = loadDotEnv(dotenvPath);
  if (Object.keys(loaded).length) {
    log(`已从 ${dotenvPath} 载入 ${Object.keys(loaded).length} 个环境变量`);
  }

  // 配置拼写检查。
  // 写了但应用从不读取的变量，绝大多数是名字拼错了（例如 AI_CHAT_API_KEY 写成了
  // AI_CHAT_KEY），而这类错误不会抛异常，只会让对应功能静默失效——排查成本极高。
  //
  // 注意这里扫的是 process.env 而不是只扫 .env 文件：
  // 容器里 .env 根本不进镜像（由 compose 的 env_file 在运行时注入），
  // 只扫文件的话这段检查在 Docker 环境下永远不执行，而那正是用户出问题的环境。
  const { typos, unread } = findSuspiciousEnvKeys(process.env);
  if (typos.length) {
    console.warn(
      `[wxchat] ⚠ 有 ${typos.length} 个变量名疑似拼写错误，它们不会被读取：\n` +
      typos.map((t) => `           - ${t.key}  →  是不是想写 ${t.suggests}？`).join('\n')
    );
  }
  if (unread.length) {
    console.warn(
      `[wxchat] ⚠ 有 ${unread.length} 个变量带本应用的命名前缀，但当前版本不会读取：\n` +
      unread.map((k) => `           - ${k}`).join('\n') +
      '\n           请对照 .env.example 确认变量名。'
    );
  }

  assertCwdIsProjectRoot();

  // 2. 路径解析：容器里用 env 指定的 /app/data 与 /app/uploads
  const dbPath = process.env.DATABASE_PATH || path.join(ROOT_DIR, 'data', 'wxchat.db');
  const uploadPath = process.env.UPLOAD_PATH || path.join(ROOT_DIR, 'uploads');
  const publicDir = process.env.PUBLIC_PATH || path.join(ROOT_DIR, 'public');
  const schemaPath = process.env.SCHEMA_PATH || path.join(ROOT_DIR, 'database', 'schema.sql');
  const port = parseIntEnv(process.env.PORT, 3000) || 3000;
  const hostname = process.env.HOST || '0.0.0.0';

  printEnvironmentBanner({ dbPath, uploadPath, publicDir });

  // 3. 目录准备：必须**真的可写**。
  //    只 mkdir 是不够的——目录已存在时 mkdir 会静默成功，哪怕它只读，
  //    之后 SQLite 只会抛一个没有上下文的 CANTOPEN，排查成本极高。
  ensureWritableDir(path.dirname(dbPath), '数据目录');
  ensureWritableDir(uploadPath, '上传目录');

  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    fatal(`静态资源目录异常：${path.join(publicDir, 'index.html')} 不存在`);
  }

  // 4. 数据库 + 幂等 schema
  let db;
  try {
    db = createD1(dbPath);
    await initSchema(db, schemaPath);
    await db.ping();
    log(`✓ 数据库就绪（schema 已幂等应用）: ${dbPath}`);
  } catch (err) {
    fatal(`数据库初始化失败: ${dbPath}`, err);
  }

  // 5. 对象存储（目录可写性已在第 3 步验证过）
  const bucket = createR2(uploadPath);

  // 6. 静态资源 + env
  const assets = createAssets(publicDir);
  const env = createEnv({
    db,
    bucket,
    assets,
    // 旧变量名被自动兼容、或变量互相冲突时，在这里提示出来
    onWarn: (msg) => console.warn(`[wxchat] ⚠ ${msg}`),
  });

  // —— 安全配置对账 ——
  //
  // 为什么值得单独打印一段：登录失败时，用户唯一需要确认的事实是
  // 「容器里拿到的密码，和我以为的是不是同一个」。
  // 而 compose 的 env_file 会剥掉引号、按 `#` 截断行内注释、并对未加引号的值做
  // `$` 变量插值 —— 密码可能在用户毫不知情的情况下被改写。
  // 此时服务端只会回一句「密码错误」，日志里看不出任何异常，只能靠猜。
  //
  // 打印长度即可让这种改写立刻暴露：把这里的长度与 `npm run check:env`
  // 在宿主机上算出的长度一比，是否被改写一目了然。
  // 刻意只打印长度与风险特征，不打印内容本身（由 formatSecuritySection 保证）。
  for (const line of formatSecuritySection(env)) log(line);

  if (!env.ACCESS_PASSWORD) {
    console.warn(
      '[wxchat] ⚠ 未设置 ACCESS_PASSWORD，登录将始终失败。\n' +
      '         请在 .env 里配置访问密码，再执行 `docker compose up -d` 重建容器。\n' +
      '         注意：只 `restart` 不会重新读取 env_file，改完必须 up -d。'
    );
  }
  if (env.ACCESS_PASSWORD && env.ACCESS_PASSWORD.includes('$')) {
    console.warn(
      '[wxchat] ⚠ ACCESS_PASSWORD 里含 `$`。compose 会改写未加引号的值，\n' +
      '         请先在宿主机执行 `npm run check:env` 核对传入容器后是否仍是你要的值。'
    );
  }
  if (!env.JWT_SECRET) {
    console.warn('[wxchat] ⚠ 未设置 JWT_SECRET，正在使用不安全的默认值。生产环境请务必配置。');
    env.JWT_SECRET = 'wxchat-insecure-default-secret-change-me';
  }

  // 7. 应用 + 监听
  const app = createApp();

  /**
   * 给 Hono 提供 Cloudflare 风格的 executionCtx。
   * 上游 worker/routes/files.js 里用了 c.executionCtx.waitUntil(...) 做后台计数，
   * 这里用 stub 兜住，既不改业务代码，也能在关闭时等它跑完。
   */
  const pendingTasks = new Set();
  const executionCtx = {
    waitUntil(promise) {
      const task = Promise.resolve(promise).catch((err) => {
        console.warn('[waitUntil] 后台任务失败:', err?.message || err);
      });
      pendingTasks.add(task);
      task.finally(() => pendingTasks.delete(task));
    },
    passThroughOnException() { /* no-op */ }
  };

  const server = serve(
    {
      fetch: (request) => app.fetch(request, env, executionCtx),
      port,
      hostname
    },
    (info) => {
      log(`✓ 服务已启动，listening on http://${hostname}:${info.port}`);
      log(`  健康检查: http://127.0.0.1:${info.port}/api/health`);
      log(`  登录页面: http://127.0.0.1:${info.port}/login.html`);
    }
  );

  // SSE / 长轮询需要长连接，关掉 Node 的请求超时
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fatal(`端口 ${port} 已被占用。请修改 .env 里的 PORT，或释放该端口。`);
    }
    fatal('HTTP 服务异常', err);
  });

  // 8. 优雅关闭
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，开始优雅关闭…`);

    const forceExit = setTimeout(() => {
      console.warn('[wxchat] 关闭超时，强制退出');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      // SSE 连接不会自己结束，给 2 秒后强制断开
      setTimeout(() => server.closeAllConnections?.(), 2000).unref();
    });

    if (pendingTasks.size) {
      log(`等待 ${pendingTasks.size} 个后台任务完成…`);
      await Promise.allSettled([...pendingTasks]);
    }

    try {
      db.close();
      log('✓ 数据库已安全关闭');
    } catch (err) {
      console.warn('[wxchat] 关闭数据库时出错:', err?.message || err);
    }

    clearTimeout(forceExit);
    log('✓ 已退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[wxchat] 未处理的 Promise 拒绝:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[wxchat] 未捕获异常:', err);
  });
}

main().catch((err) => fatal('启动失败', err));
