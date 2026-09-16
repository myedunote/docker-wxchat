/**
 * Docker Compose 环境文件解析器
 * ============================================================
 * 为什么要自己实现一份：
 *
 * compose 的 `env_file` 不是「把文件里的字符串原样塞进容器」。它会做四件事：
 *   1. 忽略行首 `#` 注释行、忽略空行
 *   2. 剥掉成对引号（`"VAL"` / `'VAL'` 都变成 `VAL`）
 *   3. 忽略值前后的空格（`VAR = VAL` → `VAL`）
 *   4. 对**未加引号和双引号**的值做 `$` 变量插值
 *
 * 第 4 条是密码类配置的头号事故来源：
 *      ACCESS_PASSWORD=P@$$w0rd     →  P@$w0rd   （`$$` 是字面量 $）
 *      ACCESS_PASSWORD=Pa$word      →  Pa        （$word 未定义 → 空串）
 *      ACCESS_PASSWORD=abc${X}def   →  abcdef
 * 用户在 .env 里看到的是 12 个字符，容器里拿到的却是 8 个，
 * 而服务端只会回一句「密码错误」——排查成本极高。
 *
 * 另外 `#` 前面只要有空格就会被当行内注释截断：
 *      ACCESS_PASSWORD=my pass #2   →  my pass
 *
 * 本模块按官方文档实现这些规则，用来在**部署之前**回答一个问题：
 *      「这个 .env 里的值，实际会以什么内容传进容器？」
 *
 * 语义依据（均已用官方示例写成单元断言，见 DOC_EXAMPLES）：
 *   - https://docs.docker.com/compose/how-tos/environment-variables/env-file/
 *   - https://docs.docker.com/reference/compose-file/interpolation/
 *
 * 注意：这是「按文档实现」的等价模型，用于提前发现问题。
 * 真正权威的结果始终是 `docker compose config`。
 */

import fs from 'node:fs';

/** 变量名：[_a-zA-Z][_a-zA-Z0-9]* —— 与官方描述一致 */
const IDENT_RE = /^[_a-zA-Z][_a-zA-Z0-9]*/;

/** 找到一个 `{` 对应的 `}`，支持 `${A:-${B}}` 这种嵌套 */
function matchBrace(input, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < input.length; i += 1) {
    if (input[i] === '{') depth += 1;
    else if (input[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 解析 `${...}` 内部表达式。
 * 支持：NAME / NAME:-default / NAME-default / NAME:?err / NAME?err / NAME:+repl / NAME+repl
 */
function resolveBraced(expr, lookup) {
  const m = /^([_a-zA-Z][_a-zA-Z0-9]*)(:?[-?+])?([\s\S]*)$/.exec(expr);
  if (!m) {
    // 不符合变量定义的 ${...}：官方说法是「原样保留」，这里保守地原样返回
    return { value: `\${${expr}}`, problems: [{ kind: 'bad-expr', expr }] };
  }
  const [, name, op, arg] = m;
  const raw = lookup(name);
  const isSet = raw !== undefined;
  const isNonEmpty = isSet && raw !== '';
  const problems = [];

  const expandArg = () => interpolate(arg, lookup);

  if (!op) {
    if (!isSet) problems.push({ kind: 'undefined', name });
    return { value: isSet ? raw : '', problems };
  }

  switch (op) {
    case ':-':
      return { value: isNonEmpty ? raw : expandArg().value, problems };
    case '-':
      return { value: isSet ? raw : expandArg().value, problems };
    case ':?':
      if (isNonEmpty) return { value: raw, problems };
      return { value: '', problems: [{ kind: 'required', name, message: expandArg().value }] };
    case '?':
      if (isSet) return { value: raw, problems };
      return { value: '', problems: [{ kind: 'required', name, message: expandArg().value }] };
    case ':+':
      return { value: isNonEmpty ? expandArg().value : '', problems };
    case '+':
      return { value: isSet ? expandArg().value : '', problems };
    default:
      return { value: raw ?? '', problems: [{ kind: 'bad-op', expr }] };
  }
}

/**
 * 对字符串做 compose 风格插值。
 * @param {string} input
 * @param {(name: string) => string|undefined} lookup
 * @returns {{ value: string, problems: Array<object> }}
 */
export function interpolate(input, lookup = () => undefined) {
  const problems = [];
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }

    const next = input[i + 1];

    // `$$` → 字面量 $，并且阻止后续插值
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }

    // `${...}`
    if (next === '{') {
      const end = matchBrace(input, i + 1);
      if (end === -1) {
        problems.push({ kind: 'unterminated-brace', at: i });
        out += ch;
        i += 1;
        continue;
      }
      const expr = input.slice(i + 2, end);
      const r = resolveBraced(expr, lookup);
      out += r.value;
      problems.push(...r.problems);
      i = end + 1;
      continue;
    }

    // `$NAME`
    const m = IDENT_RE.exec(input.slice(i + 1));
    if (m) {
      const name = m[0];
      const v = lookup(name);
      if (v === undefined) problems.push({ kind: 'undefined', name, at: i });
      out += v === undefined ? '' : v;
      i += 1 + name.length;
      continue;
    }

    // 其余情况（如 `$1`、`$`）：官方明确「原样保留，不尝试插值」
    out += ch;
    i += 1;
  }

  return { value: out, problems };
}

/** 去掉未加引号值里的行内注释：`#` 且前面是空白才算注释 */
function stripInlineComment(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return { value: s.slice(0, i), stripped: true };
    }
  }
  return { value: s, stripped: false };
}

/** 双引号内的转义序列（官方明确支持 \n \r \t \\ 以及 \"） */
function unescapeDouble(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const n = s[i + 1];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === '\\') out += '\\';
    else if (n === '"') out += '"';
    else out += `\\${n}`; // 未知转义原样保留，不猜
    i += 1;
  }
  return out;
}

/** 单引号内只处理 `\'`，其余反斜杠保持字面（官方示例：`'some\tvalue'` → `some\tvalue`） */
function unescapeSingle(s) {
  return s.replace(/\\'/g, "'");
}

/** 找到从 start 起的、未被反斜杠转义的结束引号 */
function findClosingQuote(s, quote) {
  for (let i = 1; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return -1;
}

/** 差异原因。每条都带上「怎么改」，因为用户此刻需要的正是这个 */
const FIX_SINGLE = "用单引号包住：KEY='原值'（单引号内完全字面，不插值、不截注释）";
const FIX_DOLLAR = "用单引号包住：KEY='原值'；若必须无引号或双引号，把每个 $ 写成 $$";

const REASON = {
  interpolated: () => ({
    text: '$ 被当作变量引用做了插值（未定义的变量会被替换成空串）',
    fix: FIX_DOLLAR,
  }),
  interpolatedInDouble: () => ({
    text: '双引号**不能**阻止插值，里面的 $ 依然会被展开',
    fix: FIX_SINGLE,
  }),
  inlineComment: () => ({
    text: '`#` 前面有空格，被当作行内注释截断了（`#` 前无空格才不是注释）',
    fix: `${FIX_SINGLE}；或删掉 # 前面的空格`,
  }),
  trailingAfterQuote: (t) => ({
    text: `闭合引号后面还有 ${JSON.stringify(t)}，compose 会直接忽略它`,
    fix: '删掉闭合引号后面的内容，或把整段都放进引号里',
  }),
};

/**
 * 解析一行环境变量。
 * @returns {null | {
 *   key: string,
 *   actual: string,        // compose 最终传给容器的值
 *   intended: string,      // 「用户看起来想写的值」：去引号+去转义+trim，但不插值、不截注释
 *   quoted: 'single'|'double'|null,
 *   reasons: Array<{text: string, fix: string}>,  // actual 与 intended 不一致的原因与修法
 *   problems: Array<object>
 * }}
 */
export function parseEnvLine(rawLine, lookup = () => undefined) {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // 定界符 `=` 或 `:`，取最先出现的一个
  const eq = trimmed.indexOf('=');
  const colon = trimmed.indexOf(':');
  let sep;
  if (eq === -1) sep = colon;
  else if (colon === -1) sep = eq;
  else sep = Math.min(eq, colon);
  if (sep === -1) return null;

  const key = trimmed.slice(0, sep).trim();
  if (!key) return null;

  const rawValue = trimmed.slice(sep + 1).replace(/^\s+/, '');
  const reasons = [];
  let problems = [];
  let quoted = null;
  let body = rawValue;

  const first = rawValue[0];
  if (first === '"' || first === "'") {
    const end = findClosingQuote(rawValue, first);
    if (end !== -1) {
      quoted = first === '"' ? 'double' : 'single';
      body = rawValue.slice(1, end);
      const trailing = rawValue.slice(end + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        reasons.push(REASON.trailingAfterQuote(trailing));
      }
    }
  }

  let intended;
  let actual;

  if (quoted === 'single') {
    // 单引号：完全字面，不插值、不处理转义（除 \' ）
    intended = unescapeSingle(body);
    actual = intended;
  } else if (quoted === 'double') {
    intended = unescapeDouble(body);
    const r = interpolate(intended, lookup);
    actual = r.value;
    problems = r.problems;
    if (actual !== intended) reasons.push(REASON.interpolatedInDouble());
  } else {
    // 未加引号：先截行内注释，再 trim，再插值
    const noComment = stripInlineComment(body);
    const trimmedVal = noComment.value.trim();
    const r = interpolate(trimmedVal, lookup);
    actual = r.value;
    problems = r.problems;
    // intended：不截注释、不插值，仅 trim —— 代表「用户肉眼看到的那串字符」
    intended = body.trim();
    if (noComment.stripped && intended !== trimmedVal) {
      reasons.push(REASON.inlineComment());
    }
    if (actual !== trimmedVal) {
      reasons.push(REASON.interpolated());
    }
  }

  return { key, actual, intended, quoted, reasons, problems };
}

/**
 * 解析整个 env 文件内容。
 * 变量之间可以互相引用（`A=$B`），因此先收集全部原始行，再惰性解析。
 * @returns {{ entries: Map<string, object>, order: string[], warnings: string[] }}
 */
export function parseEnvContent(content, { shellEnv = process.env } = {}) {
  const lines = content.split(/\r?\n/);
  const order = [];
  const rawLines = new Map();
  const warnings = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    const colon = t.indexOf(':');
    let sep;
    if (eq === -1) sep = colon;
    else if (colon === -1) sep = eq;
    else sep = Math.min(eq, colon);
    if (sep === -1) continue;
    const key = t.slice(0, sep).trim();
    if (!key) continue;
    if (!rawLines.has(key)) order.push(key);
    rawLines.set(key, line);
  }

  const cache = new Map();
  const resolving = new Set();
  const entries = new Map();

  // 解析顺序：shell 环境优先于文件（compose 的取值优先级）
  const lookup = (name) => {
    if (shellEnv && Object.prototype.hasOwnProperty.call(shellEnv, name)) {
      return shellEnv[name];
    }
    if (!rawLines.has(name)) return undefined;
    if (cache.has(name)) return cache.get(name);
    if (resolving.has(name)) {
      warnings.push(`变量 ${name} 存在循环引用`);
      return undefined;
    }
    resolving.add(name);
    const parsed = parseEnvLine(rawLines.get(name), lookup);
    resolving.delete(name);
    const v = parsed ? parsed.actual : undefined;
    cache.set(name, v);
    return v;
  };

  for (const key of order) {
    const parsed = parseEnvLine(rawLines.get(key), lookup);
    if (!parsed) continue;
    cache.set(key, parsed.actual);
    entries.set(key, parsed);
  }

  return { entries, order, warnings };
}

/** 从磁盘读取并解析 */
export function parseEnvFile(filePath, opts) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseEnvContent(content, opts);
}

/**
 * 官方文档给出的解析示例。
 * 这些断言是整个模块的「可信度锚点」：只要它们全绿，
 * 解析器就与文档描述一致，体检结论才值得相信。
 */
export const DOC_EXAMPLES = [
  { name: '未加引号', line: 'VAR=VAL', expect: 'VAL' },
  { name: '双引号', line: 'VAR="VAL"', expect: 'VAL' },
  { name: '单引号', line: "VAR='VAL'", expect: 'VAL' },
  { name: '冒号定界符', line: 'VAR: VAL', expect: 'VAL' },
  { name: '定界符两侧空格', line: 'VAR = VAL', expect: 'VAL' },
  { name: '行内注释（# 前有空格）', line: 'VAR=VAL # comment', expect: 'VAL' },
  { name: '# 前无空格不是注释', line: 'VAR=VAL# not a comment', expect: 'VAL# not a comment' },
  { name: '引号内的 # 不是注释', line: 'VAR="VAL # not a comment"', expect: 'VAL # not a comment' },
  { name: '引号后跟注释', line: 'VAR="VAL" # comment', expect: 'VAL' },
  { name: '单引号内 $OTHER 保持字面', line: "VAR='$OTHER'", expect: '$OTHER' },
  { name: '单引号内 ${OTHER} 保持字面', line: "VAR='${OTHER}'", expect: '${OTHER}' },
  { name: '单引号内转义撇号', line: "VAR='Let\\'s go!'", expect: "Let's go!" },
  { name: '双引号内转义引号', line: 'VAR="{\\"hello\\": \\"json\\"}"', expect: '{"hello": "json"}' },
  { name: '双引号内 \\t 生效', line: 'VAR="some\\tvalue"', expect: 'some\tvalue' },
  { name: '单引号内 \\t 不生效', line: "VAR='some\\tvalue'", expect: 'some\\tvalue' },
  { name: '未加引号时 \\t 不生效', line: 'VAR=some\\tvalue', expect: 'some\\tvalue' },

  // —— 插值语义（依据 interpolation 官方文档）——
  { name: '$$ 是字面量 $', line: 'VAR=P@$$w0rd', expect: 'P@$w0rd' },
  { name: '未定义变量替换为空串', line: 'VAR=Pa$word', expect: 'Pa', undef: ['word'] },
  { name: '未定义 braced 变量替换为空串', line: 'VAR=abc${X}def', expect: 'abcdef', undef: ['X'] },
  { name: '$ 后不是合法变量名则原样保留', line: 'VAR=Pa$1x', expect: 'Pa$1x' },
  { name: '默认值语法', line: 'VAR=${MISSING:-fallback}', expect: 'fallback' },
  { name: '单引号内 $$ 不做字面量折叠', line: "VAR='P@$$w0rd'", expect: 'P@$$w0rd' },
];

/**
 * 自检：跑一遍官方示例。返回失败项列表（空数组 = 全部通过）。
 */
export function runSelfTest() {
  const failures = [];
  for (const ex of DOC_EXAMPLES) {
    const lookup = (n) => (ex.undef || []).includes(n) ? undefined : undefined;
    const r = parseEnvLine(ex.line, lookup);
    const got = r ? r.actual : '(null)';
    if (got !== ex.expect) {
      failures.push({ ...ex, got });
    }
  }
  return failures;
}
