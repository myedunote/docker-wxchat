/**
 * AI 链路端到端验证脚本。
 *
 * 依赖：
 *   1) 一个 OpenAI 兼容的模拟上游：  node scripts/mock-openai.js 18090
 *   2) 一个指向该上游的 wxchat 实例：
 *        PORT=18091 AI_ENABLED=true AI_API_KEY=test-key-123 \
 *        AI_API_BASE_URL=http://127.0.0.1:18090/v1 AI_MODEL=mock-model-v1 \
 *        IMAGE_GEN_ENABLED=true IMAGE_GEN_MODEL=mock-kolors-v1 node src/server.js
 *
 *      ⚠ IMAGE_GEN_MODEL 不能省。下面有两条断言会校验生图模型名，
 *        它读的是**服务端进程**的 env —— 测试进程里设了也没用。
 *        漏了不会报「你没配」，只会报「imageModel 来自配置 ✗」，
 *        看起来像产品缺陷。历史上 README 的启动命令就漏过这一项。
 *
 * 用法：
 *   WXCHAT_BASE=http://127.0.0.1:18091 ACCESS_PASSWORD=xxx node scripts/e2e-ai-test.mjs
 *
 * 注意：/api/ai/* 挂在 authMiddleware 后面，必须先登录拿 JWT，否则 401。
 *       curl 调本机服务时请加 --noproxy '*'（本机可能配了 http_proxy）。
 */
const BASE = process.env.WXCHAT_BASE || 'http://127.0.0.1:18091';
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const DEVICE = process.env.DEVICE_ID || 'e2e-device';

// 期望的模型名 —— 必须与起实例时传的 AI_MODEL / IMAGE_GEN_MODEL 一致。
// 对不上时提示必须点名是哪个环境变量，否则下一个人只能靠猜。
const EXPECT_AI_MODEL = 'mock-model-v1';
const EXPECT_IMAGE_MODEL = 'mock-kolors-v1';
const MODEL_HINT = `（起实例时需带 AI_MODEL=${EXPECT_AI_MODEL} `
  + `IMAGE_GEN_MODEL=${EXPECT_IMAGE_MODEL}，见 README「单独验证 AI 链路」）`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  →  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 可能是 SSE 原文 */ }
  return { res, text, json };
}

console.log(`\n=== 0) 未登录访问 /api/ai/config（应 401）===`);
{
  const { res, json } = await api('/api/ai/config');
  check('返回 401 UNAUTHORIZED', res.status === 401 && json?.code === 'UNAUTHORIZED', `status=${res.status} code=${json?.code}`);
}

console.log(`\n=== 1) 登录 ===`);
const { res: lr, json: lj } = await api('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
const token = lj?.data?.token || lj?.token;
check('登录成功并拿到 token', lr.ok && !!token, `status=${lr.status}`);
if (!token) {
  console.error('\n登录失败，后续用例无法执行。请检查 ACCESS_PASSWORD 是否与服务端一致。');
  process.exit(1);
}

console.log(`\n=== 2) GET /api/ai/config（登录后）===`);
{
  const { res, json } = await api('/api/ai/config', { token });
  const d = json?.data;
  check('aiEnabled = true', d?.aiEnabled === true, JSON.stringify(d));
  check('imageGenEnabled = true（回落 AI_API_KEY 生效）', d?.imageGenEnabled === true);
  check('aiModel 来自配置', d?.aiModel === EXPECT_AI_MODEL, `aiModel=${d?.aiModel}${MODEL_HINT}`);
  check('imageModel 来自配置', d?.imageModel === EXPECT_IMAGE_MODEL, `imageModel=${d?.imageModel}${MODEL_HINT}`);
  console.log('   raw:', JSON.stringify(json));
}

console.log(`\n=== 3) POST /api/ai/chat（SSE 流式透传）===`);
{
  // 契约与前端一致：content 为单句快捷写法，messages 为完整数组
  const res = await fetch(BASE + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      content: '你好，介绍一下自己',
      messages: [{ role: 'user', content: '你好，介绍一下自己' }],
      deviceId: DEVICE,
    }),
  });
  const raw = await res.text();
  const hasReasoning = raw.includes('reasoning_content');
  const hasContent = raw.includes('"content"');
  const hasDone = raw.includes('[DONE]');
  check('HTTP 200', res.status === 200, `status=${res.status}`);
  check('Content-Type 是 text/event-stream', (res.headers.get('content-type') || '').includes('text/event-stream'));
  check('含 reasoning_content（思考过程）', hasReasoning);
  check('含 content（正文）', hasContent);
  check('含 [DONE] 终止哨兵', hasDone);
  check('正文回显了配置的模型名', raw.includes('mock-model-v1'));
  console.log('   --- 流式原文 ---');
  raw.split('\n').filter(Boolean).forEach((l) => console.log('   ' + l));
}

console.log(`\n=== 3b) 复刻前端落库（/api/ai/chat 只代理、不落库）===`);
{
  // 前端 AIHandler.handleAIMessage 的完整动作是：
  //   1) API.sendMessage(问题)          → POST /api/messages
  //   2) 流式拿回答
  //   3) API.sendAIMessage(回答, ...)   → POST /api/ai/message
  // 这里补上 1 和 3，否则第 7 步的落库断言会依赖「别的测试留下的数据」而变成 flaky。
  const q = await api('/api/messages', { method: 'POST', token, body: { content: '你好，介绍一下自己', deviceId: DEVICE } });
  check('POST /api/messages 提问落库', q.res.ok && !!q.json?.data?.id, JSON.stringify(q.json?.data || q.json));

  const a = await api('/api/ai/message', {
    method: 'POST', token,
    body: { content: '收到（模型=mock-model-v1）：你好，介绍一下自己', deviceId: 'ai-system', type: 'ai_response' },
  });
  check('POST /api/ai/message 回答落库', a.res.ok && !!a.json?.data?.id, JSON.stringify(a.json?.data || a.json));
  check("落库返回的 type 是 'ai'（列值）", a.json?.data?.type === 'ai', String(a.json?.data?.type));
  check("落库返回的 originalType 保留 'ai_response'", a.json?.data?.originalType === 'ai_response',
    String(a.json?.data?.originalType));
}

console.log(`\n=== 4) 上游实际收到的请求（验证服务端真的用了配置）===`);
{
  const r = await fetch('http://127.0.0.1:18090/__requests');
  const list = await r.json();
  const chat = list.filter((x) => x.path.endsWith('/chat/completions')).at(-1);
  check('上游路径 = /v1/chat/completions', chat?.path === '/v1/chat/completions', chat?.path);
  check('上游收到 Authorization: Bearer', /^Bearer .+/.test(chat?.auth || ''), chat?.auth);
  check('model = mock-model-v1', chat?.body?.model === 'mock-model-v1', chat?.body?.model);
  check('stream = true', chat?.body?.stream === true);
  check('max_tokens = 4000', chat?.body?.max_tokens === 4000, String(chat?.body?.max_tokens));
  check('temperature = 0.7', chat?.body?.temperature === 0.7, String(chat?.body?.temperature));
  const msgs = chat?.body?.messages || [];
  console.log(`   messages 条数: ${msgs.length}  →  ${JSON.stringify(msgs)}`);
  check('messages 只含当前这一句（无多轮上下文）', msgs.length === 1 && msgs[0]?.role === 'user');
}

console.log(`\n=== 5) POST /api/ai/image（生图）===`);
let imageUrl = '';
{
  const { res, json } = await api('/api/ai/image', {
    method: 'POST',
    token,
    body: { prompt: '一只在敲代码的猫', size: '1024x1024', steps: 20, guidance: 7.5 },
  });
  imageUrl = json?.data?.images?.[0]?.url || '';
  check('HTTP 200 且返回图片 URL', res.ok && !!imageUrl, imageUrl);
  const r2 = await fetch('http://127.0.0.1:18090/__requests');
  const gen = (await r2.json()).filter((x) => x.path.endsWith('/images/generations')).at(-1);

  // IMAGE_GEN_BASE_URL 必须真的被用上（留空才回落 AI_API_BASE_URL）。
  // 曾经这个变量在 env 层被读取却从未被路由消费，配了等于没配。
  // 起实例时把 IMAGE_GEN_BASE_URL 设成一个不同的前缀，这里断言请求确实发到了那里。
  const expectBasePath = process.env.EXPECT_IMAGE_BASE_PATH;
  if (expectBasePath) {
    check(`生图请求发到了 IMAGE_GEN_BASE_URL 的路径 ${expectBasePath}`,
      gen?.path === `${expectBasePath}/images/generations`,
      `实际 ${gen?.path}`);
  } else {
    check('上游路径 = /v1/images/generations', gen?.path === '/v1/images/generations', gen?.path);
  }
  check('上游 model = mock-kolors-v1', gen?.body?.model === EXPECT_IMAGE_MODEL, `${gen?.body?.model}${MODEL_HINT}`);
  console.log('   上游收到:', JSON.stringify(gen?.body));
}

console.log(`\n=== 6) POST /api/ai/image/save（下载并入库）===`);
{
  const { res, json } = await api('/api/ai/image/save', {
    method: 'POST',
    token,
    body: { imageUrl, deviceId: DEVICE, prompt: '一只在敲代码的猫' },
  });
  check('HTTP 200 且保存成功', res.ok && json?.success === true, JSON.stringify(json?.data || json));
  const d = json?.data;
  if (d) {
    check('返回了 fileId', !!d.fileId, String(d.fileId));
    check('返回了 r2Key', !!d.r2Key, d.r2Key);
    check('返回了 fileName', !!d.fileName, d.fileName);
    check('返回了 fileSize（>0 说明真的下载到了字节）', d.fileSize > 0, String(d.fileSize));
  }
}

console.log(`\n=== 7) GET /api/messages（确认提问与回答都已落库）===`);
{
  // 注意：/api/messages 是单会话「文件传输助手」，所有设备共享同一条消息流，
  // deviceId 查询参数会被忽略（路由只读 limit/offset/beforeId/afterId）。
  // 因此这里看到的是库里全部消息，可能含之前测试留下的数据 —— 断言用 some 而非精确计数。
  const { json } = await api(`/api/messages`, { token });
  const list = json?.data?.messages || json?.data || [];
  const arr = Array.isArray(list) ? list : [];
  console.log(`   消息数: ${arr.length}`);
  arr.forEach((m) => {
    const preview = String(m.content || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`   - type=${m.type}  sender=${m.sender || m.device_id || '-'}  ${preview}`);
  });
  check('提问已落库（type=text）', arr.some((m) => m.type === 'text'));

  // 注意：DB 列 type 固定存 'ai'（不是 'ai_response'），
  // 前端传的 'ai_response' 会被 MessageService.createAIMessage 写进 meta.aiType。
  // 这是有意设计，别按字面把 'ai_response' 当成列值来断言。
  const aiMsg = arr.find((m) => m.type === 'ai');
  check('AI 回答已落库（type=ai）', !!aiMsg);
  if (aiMsg) {
    check('AI 回答的 sender = ai-system', (aiMsg.sender || aiMsg.device_id) === 'ai-system',
      String(aiMsg.sender || aiMsg.device_id));
    let aiType = null;
    try { aiType = JSON.parse(aiMsg.meta || '{}')?.aiType ?? null; } catch { /* meta 非 JSON */ }
    check("meta.aiType 保留了子类型 'ai_response'", aiType === 'ai_response', String(aiType));
  }

  check('生图结果已落库（type=file）', arr.some((m) => m.type === 'file'));
}

console.log(`\n=== 结果 ===`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
