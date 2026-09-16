/**
 * 模拟一个 OpenAI 兼容的上游服务，用于端到端验证 AI 对话与生图链路。
 *
 * 提供：
 *   POST /v1/chat/completions   → SSE 流式返回（含 reasoning_content，模拟推理模型）
 *   POST /v1/images/generations → 返回一个指向 /__image.png 的图片 URL
 *   GET  /__image.png           → 1x1 PNG（供「保存到聊天」流程下载）
 *   GET  /__requests            → 调试用：回看收到过哪些请求
 *
 * 注意：鉴权只作用于 OpenAI 兼容端点；/__* 是本地调试端点，
 * 必须免鉴权 —— 否则「保存图片」这一步会拿到 401 而误判为下载失败。
 *
 * 用法：node scripts/mock-openai.js [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 18090);
const requests = [];

/** 1x1 透明 PNG */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({ _raw: raw });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const auth = req.headers.authorization || '';
  const body = req.method === 'POST' ? await readBody(req) : null;
  requests.push({ method: req.method, path: url.pathname, auth, body });

  // 本地调试端点一律免鉴权（见文件头注释）
  const isDebugPath = url.pathname.startsWith('/__');

  // 便于测试断言：调用 OpenAI 兼容端点时必须带上 Bearer 且非空
  if (!isDebugPath && !/^Bearer .+/.test(auth)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    return;
  }

  // ---------- 调试：回看请求 ----------
  if (url.pathname === '/__requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requests, null, 2));
    return;
  }

  // ---------- 对话（SSE 流式）----------
  if (url.pathname.endsWith('/chat/completions')) {
    if (body?.stream !== true) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'expected stream:true' } }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const userMsg = body.messages?.at(-1)?.content || '';
    // 故意把 model 回显出来，方便确认服务端真的用了配置的模型
    const chunks = [
      { choices: [{ delta: { reasoning_content: '先想一下：' } }] },
      { choices: [{ delta: { reasoning_content: `用户问的是「${userMsg}」` } }] },
      { choices: [{ delta: { content: `收到（模型=${body.model}）：` } }] },
      { choices: [{ delta: { content: userMsg } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      await new Promise((r) => setTimeout(r, 20));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ---------- 生图 ----------
  if (url.pathname.endsWith('/images/generations')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        images: [
          { url: `http://127.0.0.1:${PORT}/__image.png?p=${encodeURIComponent(body?.prompt || '')}` },
        ],
        _echo: { model: body?.model, image_size: body?.image_size, prompt: body?.prompt },
      })
    );
    return;
  }

  // ---------- 供生图保存流程下载的图片 ----------
  if (url.pathname === '/__image.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1x1.length });
    res.end(PNG_1x1);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route: ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-openai] base URL 请填 http://127.0.0.1:${PORT}/v1`);
});
