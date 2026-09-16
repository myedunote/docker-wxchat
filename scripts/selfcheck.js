/**
 * 端到端自检脚本
 *
 * 对「已经跑起来」的实例做一轮真实 HTTP 校验，覆盖上游全部 API 契约
 * 以及 Docker 版新增能力（单条删除、可配置项、滑动确认前置的清空逻辑）。
 *
 * 用法：
 *   node scripts/selfcheck.js
 *   BASE_URL=http://127.0.0.1:3000 ACCESS_PASSWORD=xxx node scripts/selfcheck.js
 *
 * 退出码 0 = 全部通过；非 0 = 有失败项（CI 可直接用）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditEnvUsage } from './audit-env-usage.mjs';
import { runSelfTest, parseEnvLine, DOC_EXAMPLES } from './lib/compose-env.js';
import { formatSecuritySection, findSuspiciousEnvKeys } from '../src/adapter/env.js';
import { describeLoginFailure } from '../src/worker/auth.js';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PASSWORD = process.env.ACCESS_PASSWORD || 'test-password-123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function req(path, { method = 'GET', token, body, raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) h['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: h,
    body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined)
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, res };
}

async function main() {
  console.log('='.repeat(62));
  console.log(`docker-wxchat 端到端自检  →  ${BASE_URL}`);
  console.log('='.repeat(62));

  // ---------- 1. 健康检查 ----------
  section('[1] 健康检查（无需鉴权）');
  const health = await req('/api/health');
  check('GET /api/health 返回 200', health.status === 200, `实际 ${health.status}`);
  check('health.success = true', health.json?.success === true);
  check('schema 状态为 ready', health.json?.data?.schema === 'ready', `实际 ${health.json?.data?.schema}`);

  // ---------- 2. 静态资源 ----------
  section('[2] 静态资源托管');
  for (const p of ['/login.html', '/index.html', '/js/app.js', '/css/variables.css', '/manifest.json']) {
    const r = await req(p, { raw: true });
    check(`GET ${p} → 200`, r.status === 200, `实际 ${r.status}`);
  }
  const spa = await req('/some/unknown/route', { raw: true });
  check('未知路径回落 index.html（SPA fallback）', spa.status === 200);
  const traversal = await req('/../package.json', { raw: true });
  check('路径穿越被拦截', traversal.status !== 200 || !(await traversal.text()).includes('docker-wxchat'),
    `实际 ${traversal.status}`);

  // Service Worker 缓存名必须跟着产品版本走。
  // 静态资源是 cache-first，而浏览器只在 sw.js 内容变化时才检查更新 ——
  // 改了 CSS/JS 却没 bump CACHE_NAME，老用户会一直吃旧缓存，修复「看不到」。
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const swSrc = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const m = swSrc.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    check('sw.js 能解析出 CACHE_NAME', !!m, m ? m[1] : '未匹配到');
    if (m) {
      check(`CACHE_NAME 含当前版本号 ${pkg.version}（发布纪律）`,
        m[1].includes(pkg.version),
        `CACHE_NAME=${m[1]}，package.json version=${pkg.version}；改了静态资源就要 bump 它`);
    }
  } catch (e) {
    check('sw.js 缓存名检查', false, e.message);
  }

  // 不变量：HTML 实际加载的 js/css 必须都进了 PRECACHE。
  // PRECACHE 是手工维护的列表，新增一个 js 文件忘了登记，
  // 在线时毫无症状、离线时静默缺资源 —— 很难被人工发现。
  try {
    const swSrc = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const precached = new Set([...swSrc.matchAll(/^\s*'(\/[^']+)'/gm)].map((m) => m[1]));
    const refs = new Set();
    for (const page of ['index.html', 'login.html']) {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css))"/g)) refs.add(`/${m[1]}`);
    }
    const notPrecached = [...refs].filter((r) => !precached.has(r));
    check(`HTML 引用的 ${refs.size} 个 js/css 都已预缓存`,
      notPrecached.length === 0,
      notPrecached.length ? `未登记：${notPrecached.join(', ')}` : '');

    // 反方向：PRECACHE 里登记的每个文件都必须真的存在。
    // 与上一条合起来形成闭合：HTML 引用 ⊆ PRECACHE ⊆ 磁盘。
    // 这条同时是 Dockerfile 的构建期断言（scripts/verify-precache.js），
    // 放在这里让本地不构建镜像也能立刻发现「删了/改名了却没同步清单」。
    const publicDir = fileURLToPath(new URL('../public', import.meta.url));
    const missingFiles = [...precached]
      .filter((p) => p !== '/')
      .filter((p) => !existsSync(join(publicDir, p.replace(/^\//, ''))));
    check(`PRECACHE 的 ${precached.size} 项资源都存在于 public/`,
      missingFiles.length === 0,
      missingFiles.length ? `缺失：${missingFiles.join(', ')}` : '');
  } catch (e) {
    check('PRECACHE 完整性检查', false, e.message);
  }

  // .env.example 里承诺的变量必须真的被代码消费。
  // 「配了但静默无效」是最难排查的一类问题（IMAGE_GEN_BASE_URL 曾如此）。
  try {
    const { missing, scanned } = auditEnvUsage();
    check(`.env.example 的变量都被代码消费（扫描 ${scanned} 个文件）`,
      missing.length === 0,
      missing.length ? `未被消费：${missing.join(', ')}` : '');
  } catch (e) {
    check('.env.example 变量消费审计', false, e.message);
  }

  // ---------- 2b. 配置类事故的防线 ----------
  // 这一段守护的是「配置看起来对、实际不生效」这一类最难排查的问题。
  // 用户报「输入了 ACCESS_PASSWORD 里设的密码，却提示密码错误」时，
  // 唯一能定位它的就是下面这几件工具 —— 所以工具本身也必须被测试。
  section('[2b] 配置诊断能力');

  // (1) env 解析器必须与 Docker Compose 官方文档一致。
  // 这是整个「.env 体检」结论的可信度锚点：解析器一旦跑偏，
  // 「没发现问题」这个结论本身就是假的 —— 比没有检查更危险。
  try {
    const fails = runSelfTest();
    check(`env 文件解析器符合官方 ${DOC_EXAMPLES.length} 条语法示例`,
      fails.length === 0,
      fails.length
        ? fails.map((f) => `${f.name} 期望 ${JSON.stringify(f.expect)} 实得 ${JSON.stringify(f.got)}`).join('；')
        : '');
  } catch (e) {
    check('env 文件解析器自检', false, e.message);
  }

  // (2) 必须能识别出 compose 会改写哪些值 —— 这就是「密码为什么不对」的根因检测。
  try {
    const dollar = parseEnvLine('ACCESS_PASSWORD=P@$$w0rd2026');
    check('体检能识别 $ 插值导致的改写',
      dollar.actual !== dollar.intended && dollar.reasons.length > 0,
      `intended=${JSON.stringify(dollar.intended)} actual=${JSON.stringify(dollar.actual)}`);

    const comment = parseEnvLine('IMAGE_GEN_API_KEY=key with #comment');
    check('体检能识别「空格+#」行内注释截断',
      comment.actual !== comment.intended && comment.reasons.length > 0,
      `intended=${JSON.stringify(comment.intended)} actual=${JSON.stringify(comment.actual)}`);

    // 反向对照：单引号必须能免疫改写。
    // 没有这条，「所有值都报有问题」的实现也会通过，检查就失去了意义。
    const single = parseEnvLine("ACCESS_PASSWORD='P@$$w0rd2026'");
    check('单引号能免疫改写（对照组）',
      single.actual === single.intended && single.actual === 'P@$$w0rd2026',
      `actual=${JSON.stringify(single.actual)}`);
  } catch (e) {
    check('env 体检能力', false, e.message);
  }

  // (3) 启动日志里的安全段落只能输出长度，绝不能输出密码内容。
  // 日志会被贴到工单、群里、论坛上 —— 明文一旦进去就收不回来了。
  try {
    const secret = 'this-is-a-very-secret-password';
    const text = formatSecuritySection({ ACCESS_PASSWORD: secret, JWT_SECRET: 'jwt-value-here' }).join('\n');
    check('安全配置段落包含密码长度', text.includes(`长度 ${secret.length}`));
    check('安全配置段落不包含密码内容', !text.includes(secret));
    check('安全配置段落不包含 JWT 内容', !text.includes('jwt-value-here'));
  } catch (e) {
    check('安全配置段落格式', false, e.message);
  }

  // (4) 登录失败提示必须区分「长度不一致」与「长度一致但内容不同」。
  // 这两种情况的处置方式完全不同；退化成一个笼统的「密码错误」就等于没有诊断。
  try {
    const a = describeLoginFailure('short', 'a-much-longer-password');
    const b = describeLoginFailure('a-much-longer-passwore', 'a-much-longer-password');
    check('登录失败提示：长度不一致时给出长度对账',
      a.includes('提交长度') && a.includes('期望长度'), a);
    check('登录失败提示：长度一致时给出另一种解释', !b.includes('提交长度'), b);
  } catch (e) {
    check('登录失败提示', false, e.message);
  }

  // (5) 变量名拼写检查：既要认出常见笔误，也不能对系统变量误报。
  // 误报的代价很高 —— 用户看到几条莫名其妙的告警后，会开始忽略所有告警，
  // 于是真正的那条也一起被忽略掉。
  try {
    const typo = findSuspiciousEnvKeys({ ACCESS_PASSOWRD: 'x' });
    check('拼写检查能认出 ACCESS_PASSOWRD → ACCESS_PASSWORD',
      typo.typos.length === 1 && typo.typos[0].suggests === 'ACCESS_PASSWORD',
      JSON.stringify(typo.typos));

    const noise = findSuspiciousEnvKeys({
      PATH: '/usr/bin', HOME: '/root', LS_COLORS: 'x',
      NODE_VERSION: '20', HOSTNAME: 'box', PWD: '/app',
    });
    check('拼写检查不对系统变量误报',
      noise.typos.length === 0 && noise.unread.length === 0,
      `误报：${[...noise.typos.map((t) => t.key), ...noise.unread].join(', ')}`);
  } catch (e) {
    check('变量名拼写检查', false, e.message);
  }

  // ---------- 3. 鉴权 ----------
  section('[3] 鉴权：登录 / 锁定 / 鉴权中间件');
  const unauth = await req('/api/messages');
  check('未带 token 访问业务接口 → 401', unauth.status === 401, `实际 ${unauth.status}`);

  const badLogin = await req('/api/auth/login', { method: 'POST', body: { password: '__definitely_wrong__' } });
  check('错误密码 → 401', badLogin.status === 401, `实际 ${badLogin.status}`);
  check('错误密码返回 code=BAD_PASSWORD', badLogin.json?.code === 'BAD_PASSWORD', `实际 ${badLogin.json?.code}`);

  const login = await req('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  check('正确密码 → 200', login.status === 200, `实际 ${login.status}`);
  const token = login.json?.data?.token;
  check('返回 JWT token', typeof token === 'string' && token.split('.').length === 3);

  const verify = await req('/api/auth/verify', { token });
  check('GET /api/auth/verify → valid', verify.json?.valid === true);

  const badToken = await req('/api/messages', { token: 'not.a.token' });
  check('伪造 token → 401', badToken.status === 401, `实际 ${badToken.status}`);

  // ---------- 4. 运行时可配置项 ----------
  section('[4] GET /api/config（Docker 版新增）');
  const cfg = await req('/api/config', { token });
  check('/api/config → 200', cfg.status === 200, `实际 ${cfg.status}`);
  check('下发 messageLoadDefault', typeof cfg.json?.data?.messageLoadDefault === 'number');
  check('下发 messageLoadMax', typeof cfg.json?.data?.messageLoadMax === 'number');
  check('下发 clearConfirmRequired', typeof cfg.json?.data?.clearConfirmRequired === 'boolean');
  check('不回传任何密钥', !JSON.stringify(cfg.json || {}).match(/API_KEY|JWT_SECRET|sk-/i));

  // ---------- 5. 文本消息 ----------
  section('[5] 文本消息：发送 / 拉取 / 长文本');
  const marker = `selfcheck-${Date.now()}`;
  const sent = await req('/api/messages', { method: 'POST', token, body: { content: marker, deviceId: 'selfcheck-device' } });
  check('POST /api/messages → 200', sent.status === 200, `实际 ${sent.status}`);
  const msgId = sent.json?.data?.id;
  check('返回新消息 id', Number.isFinite(msgId));

  const longText = `长文本${'A'.repeat(3000)}结尾标记`;
  const sentLong = await req('/api/messages', { method: 'POST', token, body: { content: longText, deviceId: 'selfcheck-device' } });
  const longId = sentLong.json?.data?.id;
  check('超长文本（3000+ 字符）可发送', sentLong.status === 200, `实际 ${sentLong.status}`);

  const list = await req('/api/messages?limit=5000', { token });
  check('GET /api/messages → 200', list.status === 200, `实际 ${list.status}`);
  const rows = list.json?.data || [];
  check('刚发送的消息在列表中', rows.some((m) => m.content === marker));
  check('limit 生效（默认 5000 而非上游 50）', list.json?.limit === 5000, `实际 ${list.json?.limit}`);
  const longRow = rows.find((m) => m.id === longId);
  check('长文本内容未被截断', longRow?.content === longText,
    `长度 ${longRow?.content?.length} vs 期望 ${longText.length}`);

  // ---------- 6. 文件上传 / 下载 ----------
  section('[6] 文件：上传 / 下载 / 图片预览');
  const fileContent = `hello-wxchat-${Date.now()}`;
  const fd = new FormData();
  fd.append('file', new Blob([fileContent], { type: 'text/plain' }), '自检文件.txt');
  fd.append('deviceId', 'selfcheck-device');
  const up = await req('/api/files/upload', { method: 'POST', token, body: fd });
  check('POST /api/files/upload → 200', up.status === 200, `实际 ${up.status}`);
  const r2Key = up.json?.data?.r2Key;
  check('返回 r2Key', typeof r2Key === 'string' && r2Key.startsWith('files/'));
  check('文件名含中文可保留', up.json?.data?.fileName === '自检文件.txt', `实际 ${up.json?.data?.fileName}`);

  const dl = await req(`/api/files/download/${r2Key}`, { token, raw: true });
  check('GET /api/files/download → 200', dl.status === 200, `实际 ${dl.status}`);
  check('下载内容与上传一致', (await dl.text()) === fileContent);
  check('带 Content-Disposition 附件头', !!dl.headers.get('content-disposition'));

  const missing = await req('/api/files/download/files/not-exist-123.bin', { token });
  check('下载不存在的文件 → 404', missing.status === 404, `实际 ${missing.status}`);

  // 上传后应自动生成一条 file 类型消息
  const afterUpload = await req('/api/messages?limit=5000', { token });
  const fileMsg = (afterUpload.json?.data || []).find((m) => m.type === 'file' && m.r2_key === r2Key);
  check('上传后自动入库为 file 消息', !!fileMsg);
  check('file 消息带 original_name/file_size/mime_type',
    !!fileMsg?.original_name && typeof fileMsg?.file_size === 'number' && !!fileMsg?.mime_type);

  // ---------- 7. 搜索 ----------
  section('[7] 搜索：多条件 + 建议');
  const search = await req(`/api/search?q=${encodeURIComponent('selfcheck')}&type=all`, { token });
  check('GET /api/search → 200', search.status === 200, `实际 ${search.status}`);
  check('搜索命中刚发送的消息', (search.json?.data || []).length > 0);
  check('搜索按文件名可命中', (await req(`/api/search?q=${encodeURIComponent('自检文件')}&type=file`, { token })).json?.total > 0);

  const emptyQ = await req('/api/search?q=', { token });
  check('空关键词 → 400', emptyQ.status === 400, `实际 ${emptyQ.status}`);

  const sug = await req(`/api/search/suggestions?q=${encodeURIComponent('selfcheck')}`, { token });
  check('GET /api/search/suggestions → 200', sug.status === 200, `实际 ${sug.status}`);

  // ---------- 8. 删除单条消息 ----------
  section('[8] 删除单条消息（Docker 版新增）');
  const delOne = await req(`/api/messages/${msgId}`, { method: 'DELETE', token });
  check('DELETE /api/messages/:id → 200', delOne.status === 200, `实际 ${delOne.status}`);

  const afterDel = await req('/api/messages?limit=5000', { token });
  check('目标消息已消失', !(afterDel.json?.data || []).some((m) => m.id === msgId));
  check('其它历史消息未被误删', (afterDel.json?.data || []).length > 0);

  const delMissing = await req('/api/messages/99999999', { method: 'DELETE', token });
  check('删除不存在的消息 → 404', delMissing.status === 404, `实际 ${delMissing.status}`);

  const delFileMsg = await req(`/api/messages/${fileMsg?.id}`, { method: 'DELETE', token });
  check('删除 file 消息 → 200', delFileMsg.status === 200, `实际 ${delFileMsg.status}`);
  const dlAfterDel = await req(`/api/files/download/${r2Key}`, { token, raw: true });
  check('关联磁盘对象一并清理（下载变 404）', dlAfterDel.status === 404, `实际 ${dlAfterDel.status}`);

  // ---------- 9. 实时：SSE + 长轮询 ----------
  section('[9] 实时同步：SSE / 长轮询降级');
  const sseRes = await fetch(`${BASE_URL}/api/events?deviceId=selfcheck-device&token=${encodeURIComponent(token)}&lastMessageId=0`);
  check('GET /api/events → 200', sseRes.status === 200, `实际 ${sseRes.status}`);
  check('SSE Content-Type 正确', (sseRes.headers.get('content-type') || '').includes('text/event-stream'));
  {
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !buf.includes('event: connection')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    check('SSE 首帧为 connection 事件', buf.includes('event: connection'), `收到: ${buf.slice(0, 80)}`);
    await reader.cancel().catch(() => {});
  }

  const poll = await req('/api/poll?deviceId=selfcheck-device&lastMessageId=0&timeout=1', { token });
  check('GET /api/poll → 200', poll.status === 200, `实际 ${poll.status}`);
  check('长轮询返回 hasNewMessages 字段', typeof poll.json?.hasNewMessages === 'boolean');

  // ---------- 10. 设备同步 ----------
  section('[10] 设备同步');
  const sync = await req('/api/sync', { method: 'POST', token, body: { deviceId: 'selfcheck-device', deviceName: '自检设备' } });
  check('POST /api/sync → 200', sync.status === 200, `实际 ${sync.status}`);

  // ---------- 11. AI 开关 ----------
  section('[11] AI 能力开关');
  const aiCfg = await req('/api/ai/config', { token });
  check('GET /api/ai/config → 200', aiCfg.status === 200, `实际 ${aiCfg.status}`);

  // 服务端有没有配密钥，客户端**无从推断**——自检进程的 env 和服务端进程是两回事，
  // 用客户端的 process.env 去断言服务端行为是不成立的（会把「服务端没配 key」
  // 误判成失败）。所以这里只断言确定的性质：类型正确 + 不泄漏密钥。
  // 需要精确断言时，用 EXPECT_AI_ENABLED=true|false 显式声明期望。
  const aiEnabled = aiCfg.json?.data?.aiEnabled;
  check('aiEnabled 是布尔值', typeof aiEnabled === 'boolean', `实际 ${typeof aiEnabled}`);
  check('不下发任何密钥字段', !/api[_-]?key/i.test(JSON.stringify(aiCfg.json || {})));

  const expectAi = process.env.EXPECT_AI_ENABLED;
  if (expectAi === 'true' || expectAi === 'false') {
    check(
      `aiEnabled 与 EXPECT_AI_ENABLED=${expectAi} 一致`,
      aiEnabled === (expectAi === 'true'),
      `实际 ${aiEnabled}`
    );
  } else {
    console.log(`  · 服务端 aiEnabled = ${aiEnabled}（未设 EXPECT_AI_ENABLED，跳过精确断言）`);
    console.log('    若服务端 .env 已填 AI_API_KEY，这里应为 true；为 false 说明密钥没生效。');
  }

  // ---------- 12. 一键清空 ----------
  section('[12] 一键清空（CLEAR_CONFIRM_CODE 为空时滑动确认即可）');
  const clear = await req('/api/clear-all', { method: 'POST', token, body: {} });
  check('POST /api/clear-all（不带确认码）→ 200', clear.status === 200, `实际 ${clear.status}`);
  check('返回删除统计', typeof clear.json?.data?.deletedMessages === 'number');

  const afterClear = await req('/api/messages?limit=5000', { token });
  check('清空后消息列表为空', (afterClear.json?.data || []).length === 0);
  check('清空后 total=0', afterClear.json?.total === 0);

  const legacyClear = await req('/api/sync/clear-all', { method: 'POST', token, body: {} });
  check('旧路径 /api/sync/clear-all 仍兼容', legacyClear.status === 200, `实际 ${legacyClear.status}`);

  // ---------- 13. 错误处理 ----------
  section('[13] 错误处理');
  const notFound = await req('/api/definitely-not-exist', { token });
  check('未知 API → 404 JSON', notFound.status === 404 && notFound.json?.code === 'NOT_FOUND', `实际 ${notFound.status}`);
  const badBody = await req('/api/messages', { method: 'POST', token, body: { content: '', deviceId: 'x' } });
  check('空内容 → 400', badBody.status === 400, `实际 ${badBody.status}`);

  // ---------- 14. 环境变量兼容层（纯进程内，不依赖服务）----------
  section('[14] 环境变量兼容层（旧变量名 / URL 归一化）');
  const { normalizeApiBase, ENV_ALIASES, KNOWN_ENV_KEYS } = await import('../src/adapter/env.js');

  check(
    'base URL 去掉 /chat/completions 后缀',
    normalizeApiBase('https://ai.lezi-ai.bond/v1/chat/completions') === 'https://ai.lezi-ai.bond/v1',
    `实际 ${normalizeApiBase('https://ai.lezi-ai.bond/v1/chat/completions')}`
  );
  check(
    'base URL 去掉结尾斜杠',
    normalizeApiBase('https://api.siliconflow.cn/v1/') === 'https://api.siliconflow.cn/v1'
  );
  check(
    '已是规范 base URL 时保持不变',
    normalizeApiBase('https://api.siliconflow.cn/v1') === 'https://api.siliconflow.cn/v1'
  );
  check('空值安全', normalizeApiBase('') === '' && normalizeApiBase(undefined) === undefined);

  // 别名表里的每个旧名字，都必须同时出现在「已知变量」集合里，
  // 否则启动时会被误报成「拼写错误」。
  const aliasKeys = Object.keys(ENV_ALIASES);
  const missingAliases = aliasKeys.filter((k) => !KNOWN_ENV_KEYS.has(k));
  check(`别名表 ${aliasKeys.length} 项都已登记为已知变量`, missingAliases.length === 0, `缺失 ${missingAliases.join(', ')}`);
  check(
    '每个别名的目标都是规范名',
    aliasKeys.every((k) => ENV_ALIASES[k] && ENV_ALIASES[k] !== k)
  );
  check('AI_CHAT_API_KEY → AI_API_KEY', ENV_ALIASES.AI_CHAT_API_KEY === 'AI_API_KEY');

  // ---------- 汇总 ----------
  console.log(`\n${'='.repeat(62)}`);
  console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(62));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n自检脚本自身异常：', err);
  process.exit(1);
});
