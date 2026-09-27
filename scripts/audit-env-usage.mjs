/**
 * 排查「文档里承诺了、代码从没读过」的环境变量。
 *
 * 这类问题最难查：变量名拼写正确 → 启动不报警；
 * 用户在 .env 里配了 → 以为生效了；实际被静默忽略。
 * （真实案例：IMAGE_GEN_BASE_URL 被 env 层读取并归一化，但路由从未消费它，
 *   导致把生图指向另一家服务商时静默走错地址。）
 *
 * 纯 Node 实现（fs 递归读文件），不依赖 grep —— Windows 上 execSync 走 cmd.exe
 * 没有 grep，会让整个审计变成「全部未使用」的假阳性。
 *
 * 用法：
 *   node scripts/audit-env-usage.mjs          # CLI，有问题时退出码 1
 *   import { auditEnvUsage } from './audit-env-usage.mjs'   # 供 selfcheck 复用
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 由 docker-compose / 容器运行时消费，不由 JS 读取 */
const CONSUMED_BY_INFRA = new Set([
  'PUID', 'PGID', 'DATA_DIR', 'UPLOAD_DIR',
  // 日志轮转：compose 的 logging.options 直接引用，服务端代码不需要也不应该读它们
  'LOG_MAX_SIZE', 'LOG_MAX_FILE',
]);

/** 已在文档中标注为「预留、当前版本未强制」的变量 */
const KNOWN_RESERVED = new Set(['AI_RATE_LIMIT', 'IMAGE_RATE_LIMIT']);

const SCAN_DIRS = ['src', 'public', 'scripts'];
const SCAN_FILES = ['docker-compose.yml', 'Dockerfile'];
const EXTS = new Set(['.js', '.mjs', '.yml', '.yaml', '.json', '.sql', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy-ai', 'data', 'uploads']);

/** env.js 只做「声明 + 给默认值」，不算真正消费 */
const DECLARATION_ONLY = join('src', 'adapter', 'env.js');
/** 本脚本自身 —— 它包含变量名字面量，会自我匹配造成假阳性 */
const SELF = join('scripts', 'audit-env-usage.mjs');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p)) && !/package-lock\.json$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * @returns {{rows: Array<{key:string,status:'used'|'infra'|'reserved'|'missing',detail:string}>,
 *            missing: string[], scanned: number}}
 */
export function auditEnvUsage() {
  const KEYS = readFileSync(join(ROOT, '.env.example'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.split('=')[0].trim());

  const files = [
    ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...SCAN_FILES.map((f) => join(ROOT, f))
      .filter((f) => { try { return statSync(f).isFile(); } catch { return false; } }),
  ];

  const contents = files.map((f) => ({
    rel: f.slice(ROOT.length).replace(/^[\\/]/, ''),
    text: readFileSync(f, 'utf8'),
  }));

  const usages = (key) => {
    const re = new RegExp(`\\b${key}\\b`);
    const hits = [];
    for (const c of contents) {
      if (c.rel === DECLARATION_ONLY || c.rel === SELF) continue;
      c.text.split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${c.rel}:${i + 1}`);
      });
    }
    return hits;
  };

  const rows = [];
  const missing = [];
  for (const key of KEYS) {
    if (CONSUMED_BY_INFRA.has(key)) {
      rows.push({ key, status: 'infra', detail: '由 docker-compose 消费（非 JS）' });
      continue;
    }
    const hits = usages(key);
    if (hits.length > 0) {
      rows.push({
        key, status: 'used',
        detail: hits.slice(0, 2).join(', ') + (hits.length > 2 ? ` …共${hits.length}处` : ''),
      });
    } else if (KNOWN_RESERVED.has(key)) {
      rows.push({ key, status: 'reserved', detail: '已标注为「预留、未强制」' });
    } else {
      rows.push({ key, status: 'missing', detail: '文档承诺但代码从未消费' });
      missing.push(key);
    }
  }

  return { rows, missing, scanned: files.length };
}

// ---------- CLI ----------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { rows, missing, scanned } = auditEnvUsage();
  console.log(`环境变量使用情况审计（扫描 ${scanned} 个文件）`);
  console.log('='.repeat(58));
  const mark = { used: '✓', infra: '~', reserved: '~', missing: '✗' };
  for (const r of rows) {
    console.log(`  ${mark[r.status]} ${r.key.padEnd(24)} ${r.detail}`);
  }
  console.log('='.repeat(58));
  console.log(missing.length === 0
    ? '✓ 没有「文档承诺但未实现」的变量'
    : `✗ 有 ${missing.length} 个变量在文档里承诺了但代码从未消费：${missing.join(', ')}`);
  process.exit(missing.length ? 1 : 0);
}

