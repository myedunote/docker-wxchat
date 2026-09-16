/**
 * env 适配器
 *
 * 把 Node 的 process.env 映射成上游 worker 期望的 Cloudflare env 形状，
 * 并注入 DB / R2 / ASSETS 三个绑定。
 *
 * 这样 worker/** 里的业务代码只认 c.env.XXX，完全感知不到自己跑在容器里。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 极简 .env 解析（不引第三方依赖）。已存在的真实环境变量优先，不被文件覆盖 */
export function loadDotEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  // 只填补 process.env 里没有的键
  for (const [k, v] of Object.entries(out)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return out;
}

/** 把 "true"/"1"/"yes"/"on" 解析成布尔值 */
export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** 解析正整数，非法时回落默认值 */
export function parseIntEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 环境变量别名表（别名 -> 规范名）。
 *
 * 从旧的自托管版本迁移过来时，很容易沿用旧变量名（例如 AI_CHAT_API_KEY）。
 * 这类错误**不会报错**，只会让功能静默失效：AI 入口变灰、上传限制不生效，
 * 而且日志里一个字都不提，排查成本极高。
 *
 * 因此这里做一次兼容映射：规范名优先；只有规范名缺失时才采用别名，并打印提示。
 */
export const ENV_ALIASES = {
  AI_CHAT_API_KEY: 'AI_API_KEY',
  AI_CHAT_BASE_URL: 'AI_API_BASE_URL',
  AI_CHAT_MODEL: 'AI_MODEL',
  IMAGE_GEN_API_BASE_URL: 'IMAGE_GEN_BASE_URL',
  MAX_FILE_SIZE_MB: 'MAX_FILE_SIZE', // 单位 MB，会换算成字节
};

/**
 * 应用认识的全部环境变量名。
 * 用来在启动时提示「哪些变量写了但不会被读取」——拼错名字是最高频的配置事故。
 * 除应用自身读取的变量外，也包含 compose / Docker 自身消费的那些（PUID、PGID 等），
 * 否则它们会被误报为拼写错误。
 */
export const KNOWN_ENV_KEYS = new Set([
  // 运行时与路径
  'NODE_ENV', 'PORT', 'HOST', 'TZ', 'PUBLIC_PATH', 'SCHEMA_PATH',
  'DATABASE_PATH', 'UPLOAD_PATH',
  // 鉴权
  'ACCESS_PASSWORD', 'JWT_SECRET', 'SESSION_EXPIRE_HOURS',
  'MAX_LOGIN_ATTEMPTS', 'LOGIN_LOCKOUT_MINUTES',
  // 数据清理
  'CLEAR_CONFIRM_CODE',
  // 上传与消息加载
  'MAX_FILE_SIZE', 'MAX_FILE_SIZE_MB',
  'MESSAGE_LOAD_DEFAULT', 'MESSAGE_LOAD_MAX',
  // AI 对话
  'AI_ENABLED', 'AI_API_KEY', 'AI_API_BASE_URL', 'AI_MODEL',
  'AI_MAX_TOKENS', 'AI_TEMPERATURE', 'AI_RATE_LIMIT',
  'AI_CHAT_API_KEY', 'AI_CHAT_BASE_URL', 'AI_CHAT_MODEL',
  // AI 绘画
  'IMAGE_GEN_ENABLED', 'IMAGE_GEN_API_KEY', 'IMAGE_GEN_BASE_URL',
  'IMAGE_GEN_MODEL', 'IMAGE_GEN_DEFAULT_SIZE', 'IMAGE_RATE_LIMIT',
  'IMAGE_GEN_API_BASE_URL',
  // compose / docker 自身
  'PUID', 'PGID', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES',
]);

/** 编辑距离，用于「拼写疑似有误」判断 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** 本应用自己使用的变量前缀，用来判断「写了但不被读取」 */
const CONFIG_PREFIXES = [
  'AI_', 'IMAGE_', 'ACCESS_', 'JWT_', 'SESSION_', 'LOGIN_',
  'MESSAGE_', 'CLEAR_', 'DATABASE_', 'UPLOAD_', 'PUBLIC_', 'SCHEMA_', 'MAX_',
];

/**
 * 找出「写了但不会被读取」的环境变量。
 *
 * 这类错误不会抛异常，只会让对应功能静默失效（AI 入口变灰、密码永远不对），
 * 日志里一个字都不提，排查成本极高。
 *
 * ⚠ 必须扫描 process.env，而不是只扫 .env 文件：
 *   容器里 .env 并不进镜像（由 compose 的 env_file 在运行时注入），
 *   只扫文件的话这段检查在 Docker 下永远不执行 —— 而那恰好是用户出问题的环境。
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ typos: Array<{key: string, suggests: string, distance: number}>,
 *             unread: string[] }}
 */
export function findSuspiciousEnvKeys(env = process.env) {
  const typos = [];
  const unread = [];
  const known = [...KNOWN_ENV_KEYS];

  for (const key of Object.keys(env)) {
    if (KNOWN_ENV_KEYS.has(key)) continue;
    // 只检查「看起来像本应用配置」的名字：全大写且含下划线。
    // 这条限制把 PATH / HOME / LS_COLORS / HOSTNAME 之类的系统变量全部排除，
    // 否则下面的相似度检查会产生大量误报，用户很快就不再信任这些告警。
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !key.includes('_')) continue;
    if (key.startsWith('NPM_') || key.startsWith('npm_')) continue;

    // 1) 与某个已知变量只差 1~2 个字符 → 几乎可以确定是拼写错误
    let best = null;
    for (const k of known) {
      if (Math.abs(k.length - key.length) > 2) continue;
      const d = levenshtein(key, k);
      if (d > 0 && d <= 2 && (!best || d < best.distance)) {
        best = { key, suggests: k, distance: d };
      }
    }
    if (best) {
      typos.push(best);
      continue;
    }

    // 2) 用了本应用的命名前缀，却不在已知列表里 → 写了也不会被读取
    if (CONFIG_PREFIXES.some((p) => key.startsWith(p))) unread.push(key);
  }

  return { typos, unread };
}

/**
 * 描述一个密钥型配置的「形状」，用于和 .env 对账。
 *
 * 刻意只输出长度与风险特征，不输出内容：
 * 长度是判断「容器拿到的值和我写的是不是同一个」最有效的单一信息，
 * 而一旦值被 compose 改写（$ 插值 / # 截断），长度几乎必然会变。
 */
export function describeSecret(value) {
  if (!value) return '未设置';
  const flags = [];
  if (value !== value.trim()) flags.push('首尾有空格');
  if (/\s/.test(value)) flags.push('含空白');
  if (value.includes('$')) flags.push('含 $');
  if (value.includes('#')) flags.push('含 #');
  if (value.includes('"') || value.includes("'")) flags.push('含引号');
  if (/[\u0000-\u001f]/.test(value)) flags.push('含控制字符');
  if (/[^\x20-\x7e]/.test(value)) flags.push('含非 ASCII 字符');
  return `长度 ${value.length}${flags.length ? `（${flags.join('、')}）` : ''}`;
}

/**
 * 生成启动日志里的「安全配置」段落。
 *
 * 抽成纯函数是为了让自检能直接断言「只输出长度、绝不输出内容」——
 * 这是唯一能阻止「日后有人顺手把明文打进日志」的机制。
 * 日志会被贴到工单、群里、论坛上，明文密码一旦进去就收不回来了。
 */
export function formatSecuritySection(env) {
  return [
    '---------------- 安全配置 ----------------',
    `ACCESS_PASSWORD : ${describeSecret(env.ACCESS_PASSWORD)}`,
    `JWT_SECRET      : ${describeSecret(env.JWT_SECRET)}`,
    '------------------------------------------',
  ];
}

/**
 * 归一化 OpenAI 兼容的 API base URL。
 *
 * 代码内部会自己拼 `/chat/completions`，但用户经常把完整端点写进 base，
 * 结果拼成 `https://host/v1/chat/completions/chat/completions` → 404。
 * 这里把常见后缀剥掉，两种写法都能用。
 */
export function normalizeApiBase(url) {
  if (!url) return url;
  return String(url)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

/** 取值：规范名优先，缺失时回落到别名，并记录提示 */
function pick(e, canonical, fallback, warn) {
  const canonicalVal = e[canonical];
  const alias = Object.keys(ENV_ALIASES).find((k) => ENV_ALIASES[k] === canonical);
  const aliasVal = alias ? e[alias] : undefined;

  const hasCanonical = canonicalVal !== undefined && canonicalVal !== '';
  const hasAlias = aliasVal !== undefined && aliasVal !== '';

  if (hasCanonical) {
    if (hasAlias) {
      warn(`检测到 ${canonical} 与旧名字 ${alias} 同时存在，已采用 ${canonical}，忽略 ${alias}。建议删掉后者以免混淆。`);
    }
    return canonicalVal;
  }
  if (hasAlias) {
    warn(`环境变量 ${alias} 是旧名字，已自动按 ${canonical} 处理。建议改名为 ${canonical}。`);
    return aliasVal;
  }
  return fallback;
}

/**
 * 构造 worker 用的 env 对象
 * @param {{ db: any, bucket: any, assets: any, overrides?: Record<string, any>,
 *           onWarn?: (msg: string) => void }} deps
 *        onWarn 用于上报「旧变量名被自动兼容」「变量冲突」这类配置提示
 */
export function createEnv({ db, bucket, assets, overrides = {}, onWarn = () => {} }) {
  const e = process.env;
  const warn = (msg) => onWarn(msg);

  // —— 上传上限 ——
  // 规范变量是 MAX_FILE_SIZE（单位字节，0 = 不限制）。
  // 旧版本用的是 MAX_FILE_SIZE_MB（单位 MB），这里做一次换算兼容。
  const rawMaxBytes = e.MAX_FILE_SIZE;
  const rawMaxMb = e.MAX_FILE_SIZE_MB;
  let maxFileSize = '0';
  if (rawMaxBytes !== undefined && rawMaxBytes !== '') {
    maxFileSize = rawMaxBytes;
    if (rawMaxMb !== undefined && rawMaxMb !== '') {
      warn(
        `MAX_FILE_SIZE 与旧名字 MAX_FILE_SIZE_MB 同时存在，` +
        `已采用 MAX_FILE_SIZE=${rawMaxBytes}，忽略 MAX_FILE_SIZE_MB=${rawMaxMb}。`
      );
    }
  } else if (rawMaxMb !== undefined && rawMaxMb !== '') {
    const mb = parseIntEnv(rawMaxMb, 0);
    maxFileSize = String(mb * 1024 * 1024);
    warn(
      `MAX_FILE_SIZE_MB=${rawMaxMb} 已换算为 MAX_FILE_SIZE=${maxFileSize}（字节）。` +
      `建议直接使用 MAX_FILE_SIZE。`
    );
  }

  return {
    // —— 运行时绑定（替代 Cloudflare 的 DB / R2 / ASSETS）——
    DB: db,
    R2: bucket,
    ASSETS: assets,

    // —— 鉴权 ——
    ACCESS_PASSWORD: e.ACCESS_PASSWORD || '',
    JWT_SECRET: e.JWT_SECRET || '',
    SESSION_EXPIRE_HOURS: e.SESSION_EXPIRE_HOURS || '24',
    MAX_LOGIN_ATTEMPTS: e.MAX_LOGIN_ATTEMPTS || '5',
    LOGIN_LOCKOUT_MINUTES: e.LOGIN_LOCKOUT_MINUTES || '15',

    // —— 数据清理 ——
    // 留空 => 前端只需滑动确认；填了 => 额外要求输入确认码
    CLEAR_CONFIRM_CODE: e.CLEAR_CONFIRM_CODE || '',

    // —— 上传 ——
    // 0 表示不限制
    MAX_FILE_SIZE: maxFileSize,

    // —— 消息加载 ——
    MESSAGE_LOAD_DEFAULT: e.MESSAGE_LOAD_DEFAULT || '5000',
    MESSAGE_LOAD_MAX: e.MESSAGE_LOAD_MAX || '100000',

    // —— AI 对话 ——
    AI_ENABLED: e.AI_ENABLED || 'true',
    AI_API_KEY: pick(e, 'AI_API_KEY', '', warn),
    AI_API_BASE_URL: normalizeApiBase(
      pick(e, 'AI_API_BASE_URL', 'https://api.siliconflow.cn/v1', warn)
    ),
    AI_MODEL: pick(e, 'AI_MODEL', 'deepseek-ai/DeepSeek-R1', warn),
    AI_MAX_TOKENS: e.AI_MAX_TOKENS || '4000',
    AI_TEMPERATURE: e.AI_TEMPERATURE || '0.7',
    AI_RATE_LIMIT: e.AI_RATE_LIMIT || '10',

    // —— AI 绘画 ——
    IMAGE_GEN_ENABLED: e.IMAGE_GEN_ENABLED || 'true',
    IMAGE_GEN_API_KEY: e.IMAGE_GEN_API_KEY || '',
    IMAGE_GEN_BASE_URL: normalizeApiBase(pick(e, 'IMAGE_GEN_BASE_URL', '', warn)),
    IMAGE_GEN_MODEL: e.IMAGE_GEN_MODEL || 'Kwai-Kolors/Kolors',
    IMAGE_GEN_DEFAULT_SIZE: e.IMAGE_GEN_DEFAULT_SIZE || '1024x1024',
    IMAGE_RATE_LIMIT: e.IMAGE_RATE_LIMIT || '5',

    // —— 运行环境 ——
    ENVIRONMENT: e.NODE_ENV === 'production' ? 'production' : 'development',
    TZ: e.TZ || 'Asia/Shanghai',

    ...overrides
  };
}

/**
 * Cloudflare 的 c.executionCtx.waitUntil 在 Node 下并不存在，
 * 这里提供一个安全包装：能拿到就交给运行时，拿不到就自己兜底吞掉异常，
 * 避免「后台任务」把主请求带崩。
 */
export function waitUntil(c, promise) {
  const p = Promise.resolve(promise).catch((err) => {
    console.warn('[waitUntil] 后台任务失败:', err?.message || err);
  });
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // 没有 executionCtx 时静默处理
  }
  return p;
}

export const ROOT_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..'
);
