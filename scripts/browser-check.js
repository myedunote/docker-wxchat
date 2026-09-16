/**
 * 浏览器端 UI 冒烟测试（零依赖，走原生 CDP）
 *
 * 目的：验证前端不只是「语法正确」，而是在真实浏览器里真的能跑通：
 *   登录 -> 发文本 -> 长文本不截断 -> 上传文件 -> 复制 -> 删除单条 -> 滑动确认清空
 * 同时收集控制台报错与未捕获异常。
 *
 * 用法：node scripts/browser-check.js
 *      HEADED=1 node scripts/browser-check.js   # 打开有头窗口观察
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9333;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = process.env.ACCESS_PASSWORD || 'test-password-123';
const HEADLESS = process.env.HEADED !== '1';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

let passed = 0;
const failures = [];
const consoleErrors = [];
const pageErrors = [];
/** 观察到的网络请求 URL（含 blob: 与 download 直链），用于断言走了哪条下载路径 */
const netRequests = [];
/**
 * 浏览器真正发起下载时的事件（`Page/Browser.downloadWillBegin`）。
 *
 * 为什么不用 `Network.requestWillBeSent` 抓下载：**下载不会触发它**。
 * 实测踩过：文件明明已经落到磁盘上、内容也对，但 netRequests 里空空如也，
 * 断言直接报「未观察到下载请求」—— 那是抓错了事件，不是功能有问题。
 */
const downloads = [];

/** 模拟 Android Chrome 的 UA —— 用来验证「移动端走直链」在真实浏览器里真的成立 */
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S9110) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** token 是 JWT，不能进日志 —— 打印前统一打码 */
const maskToken = (u) => (u || '').replace(/([?&]token=)[^&]*/g, '$1<redacted>');

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(150);
  }
  throw new Error(`等待超时: ${label} (最后状态: ${JSON.stringify(last)})`);
}

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('未找到 Chrome/Edge，无法进行浏览器验证');
  console.log(`浏览器: ${chromePath}`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'wxchat-cdp-'));
  const child = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--no-sandbox',
    ...(HEADLESS ? ['--headless=new'] : []),
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let dlDir = null;
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok,
      { timeout: 25000, label: 'Chrome 调试端口' });

    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', j, { once: true });
    });

    let id = 1;
    const pending = new Map();
    let send;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') {
        netRequests.push(msg.params.request.url);
      }
      if (msg.method === 'Page.downloadWillBegin' || msg.method === 'Browser.downloadWillBegin') {
        downloads.push(msg.params);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`timeout ${method}`)); } }, 60000);
    });

    /** 求值；默认等待 Promise。对「不会 resolve 的 Promise」必须传 awaitPromise:false */
    const evaluate = async (expression, { awaitPromise = true } = {}) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');

    // ---------- 登录 ----------
    section('[1] 登录页');
    await send('Page.navigate', { url: `${BASE}/login.html` });
    await waitFor(() => evaluate(`document.readyState === 'complete'`), { label: '登录页加载' });
    check('登录页标题正确', (await evaluate('document.title')).includes('登录'));
    check('存在密码输入框', await evaluate(`!!document.querySelector('#passwordInput')`));

    await evaluate(`(() => {
      const i = document.querySelector('#passwordInput');
      i.value = ${JSON.stringify(PASSWORD)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#loginButton').click();
      return true;
    })()`);

    await waitFor(() => evaluate(`location.pathname.includes('index')`), { label: '登录后跳转', timeout: 20000 });
    check('登录成功并跳转到主页面', true);

    // ---------- 主页面就绪（关键：等异步 init 真正跑完）----------
    section('[2] 主页面初始化');
    await waitFor(() => evaluate(`!!window.app && window.app.isInitialized === true`),
      { label: 'app.init 完成', timeout: 20000 });
    check('应用已初始化（app.isInitialized）', true);
    check('ServerConfig 已应用服务端配置', await evaluate('CONFIG.RUNTIME.loaded === true'));
    check('加载条数来自服务端（5000）', (await evaluate('CONFIG.RUNTIME.messageLoadDefault')) === 5000,
      `实际 ${await evaluate('CONFIG.RUNTIME.messageLoadDefault')}`);
    check('清空不需要确认码', (await evaluate('CONFIG.RUNTIME.clearConfirmRequired')) === false);
    check('新消息浮标已挂载', await evaluate(`!!document.querySelector('#newMessagesBadge')`));

    // ---------- 发送文本 ----------
    section('[3] 发送文本消息（含长文本不截断）');
    const marker = `浏览器验证-${Date.now()}`;
    const longTail = 'B'.repeat(2200);
    const fullText = marker + longTail;

    await evaluate(`(() => {
      const ta = document.querySelector('#messageText');
      ta.value = ${JSON.stringify(fullText)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#messageForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    // 等服务端真的存下来（端到端闭环）
    const storedLen = await waitFor(async () => {
      const len = await evaluate(`(async () => {
        const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
        const hit = (j.data || []).find(m => (m.content || '').includes(${JSON.stringify(marker)}));
        return hit ? hit.content.length : 0;
      })()`);
      return len || false;
    }, { label: '消息入库', timeout: 20000 });
    check('消息已落库', storedLen > 0);
    check('服务端存储的长文本未截断', storedLen === fullText.length, `实际 ${storedLen} vs 期望 ${fullText.length}`);

    // 等前端把这条消息渲染进 DOM（乐观气泡会被服务端消息替换）
    const domLen = await waitFor(async () => {
      const len = await evaluate(`(() => {
        const els = [...document.querySelectorAll('.message-bubble')];
        const hit = els.find(e => (e.textContent || '').includes(${JSON.stringify(marker)}));
        return hit ? (hit.textContent || '').length : 0;
      })()`);
      return len || false;
    }, { label: '长文本气泡渲染', timeout: 15000 });
    check('长文本完整渲染未截断', domLen === fullText.length, `实际 ${domLen} vs 期望 ${fullText.length}`);

    // ---------- 消息操作 ----------
    section('[4] 一键复制 / 删除单条');
    const actions = await evaluate(`document.querySelectorAll('.message-actions .message-action-btn').length`);
    check('消息带复制/删除操作按钮', actions >= 2, `实际 ${actions}`);

    // 无头环境下剪贴板权限可能被拒，这里验证「复制链路可用 + 有明确返回值」，
    // 而不是强制断言剪贴板内容（那是环境能力，不是代码缺陷）
    const copyProbe = await evaluate(`(async () => {
      const el = [...document.querySelectorAll('.message[data-message-id]')].pop();
      const msg = UI.messageCache.get(el.dataset.messageId);
      const hasFn = typeof MessageRenderer.copyMessage === 'function';
      const text = msg.type === 'file' ? (msg.original_name || '') : (msg.content || '');
      const ok = await MessageRenderer.copyMessage(msg);
      return { hasFn, type: typeof ok, textLen: text.length, ok };
    })()`);
    check('复制入口存在且返回布尔值', copyProbe.hasFn && copyProbe.type === 'boolean',
      JSON.stringify(copyProbe));

    const delResult = await evaluate(`(async () => {
      const before = (await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json()).total;
      const el = [...document.querySelectorAll('.message[data-message-id]')].pop();
      const mid = el.dataset.messageId;
      const ok = await MessageHandler.deleteMessage(mid);
      const after = (await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json()).total;
      return { ok, mid, before, after };
    })()`);
    check('删除单条返回成功', delResult.ok === true, JSON.stringify(delResult));
    check('服务端总数减 1', delResult.after === delResult.before - 1, `${delResult.before} -> ${delResult.after}`);

    const domGone = await waitFor(async () => {
      const gone = await evaluate(`!document.querySelector('[data-message-id="${delResult.mid}"]')`);
      return gone;
    }, { label: '气泡从 DOM 移除', timeout: 5000 }).catch(() => false);
    check('对应气泡已从 DOM 移除', domGone === true);

    // ---------- 文件上传 ----------
    section('[5] 文件上传（含进度与速度）');
    await evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['浏览器上传验证内容'], '浏览器验证.txt', { type: 'text/plain' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    await waitFor(async () => {
      return await evaluate(`(async () => {
        const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
        return (j.data || []).some(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      })()`);
    }, { label: '文件消息入库', timeout: 20000 });
    check('文件上传成功并入库为消息', true);

    const dlOk = await evaluate(`(async () => {
      const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
      const f = (j.data || []).find(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      if (!f) return 'no-file';
      const r = await fetch('/api/files/download/' + f.r2_key, { headers: Auth.addAuthHeader({}) });
      return r.status + '|' + (await r.text());
    })()`);
    check('中文名文件可正常下载且内容一致', dlOk === '200|浏览器上传验证内容', `实际 ${dlOk}`);

    // 上面那条用的是裸 fetch —— 它只证明「服务端能吐文件」，
    // 却**绕过了 API.request 的超时逻辑**，而缺陷恰恰就在那一层。
    // 曾经因此漏掉一个线上问题：downloadFile 传 timeout: 0 表示「大文件不设硬超时」，
    // 但 request() 把 0 直接丢给 setTimeout → 下一个 tick 就 abort，
    // 于是每次下载都报「请求超时」。裸 fetch 测不出来。
    // 所以这里必须走 downloadFile 真正用的那条路径。
    const dlViaApi = await evaluate(`(async () => {
      const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
      const f = (j.data || []).find(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      if (!f) return 'no-file';
      const url = '/api/files/download/' + encodeURIComponent(f.r2_key).replace(/%2F/g, '/');
      try {
        const res = await API.request(url, { method: 'GET', raw: true, timeout: 0 });
        const buf = await res.arrayBuffer();
        return res.status + '|' + new TextDecoder().decode(buf);
      } catch (e) {
        return 'ERR|' + (e.message || e);
      }
    })()`);
    check('经 API.request 走 timeout:0 下载成功（downloadFile 的真实路径）',
      dlViaApi === '200|浏览器上传验证内容', `实际 ${dlViaApi}`);

    // 最贴近用户操作的一条：直接调用「下载」按钮最终会走的那整个函数，
    // 连同 URL 拼接、流式读取、blob 组装、触发保存一起验掉。
    // 返回值是实际采用的下载方式：桌面端必须是 'stream'（否则会丢掉进度条）。
    const dlFn = await evaluate(`(async () => {
      const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
      const f = (j.data || []).find(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      if (!f) return 'no-file';
      try {
        const mode = await API.downloadFile(f.r2_key, f.original_name, () => {});
        return mode === 'stream' ? 'ok' : 'bad:' + mode;
      } catch (e) {
        return 'ERR|' + (e.message || e);
      }
    })()`);
    check('调用 API.downloadFile 成功（用户点「下载」的真实入口，桌面走流式）',
      dlFn === 'ok', `实际 ${dlFn}`);

    // 反向对照：有限超时必须仍然生效。
    // 少了这条，「把所有超时一律关掉」也能让上面那条通过 —— 检查就白做了。
    // /api/poll 在无新消息时会挂住 25 秒，正好当「慢接口」用。
    const timeoutStillWorks = await evaluate(`(async () => {
      try {
        await API.request('/api/poll?deviceId=__probe__&lastMessageId=999999999&timeout=25',
          { method: 'GET', raw: true, timeout: 300 });
        return 'no-timeout';
      } catch (e) {
        return (e.message || '').startsWith('请求超时') ? 'aborted' : 'other:' + e.message;
      }
    })()`);
    check('有限超时仍然生效（timeout:300 打长轮询会被中止）',
      timeoutStillWorks === 'aborted', `实际 ${timeoutStillWorks}`);

    // ---------- 移动端下载路径（直链 + 原生下载器） ----------
    //
    // 移动端不能用 Blob + `<a download>`：
    //   1. 大量移动端浏览器是 WebView（微信/QQ/UC/夸克…），不支持 blob: 下载，
    //      `a.click()` 被静默忽略 —— 不报错、不下载，前端毫无反馈；
    //   2. Blob 必须先 await 完整个文件再 click，此时用户手势的
    //      transient activation 窗口（约 5s）早已过期，会被当「自动下载」拦掉。
    // 所以移动端改走「带 token 的直链」，交给浏览器原生下载器。
    //
    // 这里先验**这条链路成立所依赖的两个前提**，而不是它的表象：
    //   ① 平台判定正确（桌面不能被误判，iPadOS 的 Macintosh UA 不能漏）；
    //   ② 直链在「不带任何请求头」时仍能通过鉴权并拿到文件 ——
    //      原生下载是顶层导航，本来就没法设置 Authorization 头。
    // 真正的「点下去、文件落盘」在下面用移动端模拟验（见 [5b]）。
    const uaProbe = await evaluate(`(() => {
      const cases = [
        ['Android Chrome', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', 'Linux x86_64', 0, true],
        ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone', 5, true],
        ['iPadOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'MacIntel', 5, true],
        ['桌面 Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Win32', 0, false]
      ];
      const bad = [];
      for (const c of cases) {
        Object.defineProperty(navigator, 'userAgent', { value: c[1], configurable: true });
        Object.defineProperty(navigator, 'platform', { value: c[2], configurable: true });
        Object.defineProperty(navigator, 'maxTouchPoints', { value: c[3], configurable: true });
        const got = Utils.useNativeDownload();
        if (got !== c[4]) bad.push(c[0] + '→' + got);
      }
      delete navigator.userAgent;
      delete navigator.platform;
      delete navigator.maxTouchPoints;
      return bad.length ? 'FAIL: ' + bad.join(', ') : 'ok';
    })()`);
    check('平台判定：Android/iPhone/iPadOS 走直链，桌面走流式',
      uaProbe === 'ok', `实际 ${uaProbe}`);

    // ⚠ 下面两条都必须显式 `cache: 'no-store'`。
    //   下载响应带 `Cache-Control: private, max-age=3600`（src/worker/routes/files.js），
    //   浏览器会把它缓存 1 小时；而浏览器私有缓存**可以**跨 Authorization 复用
    //   （RFC 7234 只禁止共享缓存这么做）。
    //   于是「去掉 token」那条会命中前面带 token 下载时写下的缓存副本，
    //   拿到一个假的 200 —— 反向对照就失效了，看起来像「鉴权不存在」。
    //   这坑踩过一次：不加 no-store 时该断言报「实际 200」，与 curl 的 401 直接矛盾。
    const dlDirect = await evaluate(`(async () => {
      const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
      const f = (j.data || []).find(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      if (!f) return { err: 'no-file' };
      const url = API.getDownloadUrl(f.r2_key);
      if (url.indexOf('?token=') < 0) return { err: 'no-token' };
      const r = await fetch(url, { cache: 'no-store' });   // 刻意不带任何请求头，模拟原生下载
      return {
        status: r.status,
        body: await r.text(),
        cd: r.headers.get('content-disposition') || '',
        rp: r.headers.get('referrer-policy') || '',
        nosniff: r.headers.get('x-content-type-options') || ''
      };
    })()`);
    check('移动端直链：无请求头 + ?token= 可下载，且带 attachment 与中文名',
      dlDirect.status === 200
      && dlDirect.body === '浏览器上传验证内容'
      && dlDirect.cd.includes('attachment')
      && dlDirect.cd.includes("filename*=UTF-8''"),
      `实际 ${JSON.stringify({ status: dlDirect.status, err: dlDirect.err, cd: dlDirect.cd })}`);
    // 直链把凭据（24 小时有效的 JWT）放在 URL 里，就不能让它经 Referer 泄给第三方
    check('下载响应带 no-referrer + nosniff',
      dlDirect.rp === 'no-referrer' && dlDirect.nosniff === 'nosniff',
      `referrer-policy=${JSON.stringify(dlDirect.rp)} nosniff=${JSON.stringify(dlDirect.nosniff)}`);

    // 反向对照：去掉 token 必须 401。
    // 少了这条，「鉴权整个失效」也能让上面那条通过。
    const dlNoToken = await evaluate(`(async () => {
      const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
      const f = (j.data || []).find(m => m.type === 'file' && m.original_name === '浏览器验证.txt');
      if (!f) return 'no-file';
      const r = await fetch(API.getDownloadPath(f.r2_key), { cache: 'no-store' });
      return String(r.status);
    })()`);
    check('反向对照：直链去掉 token 返回 401',
      dlNoToken === '401', `实际 ${dlNoToken}`);

    // ---------- 移动端下载：真机行为模拟 ----------
    //
    // 上面那几条只验了「直链能过鉴权」这个前提。这一节更进一步：
    // 用 CDP 把浏览器**真的伪装成 Android Chrome**（UA + 触屏 + 移动视口），
    // 点击真实的下载按钮，然后断言**文件真的落到了磁盘上**。
    //
    // 为什么值得这么麻烦：用户报的现象是「提示下载完成，但文件没保存」——
    // 那是浏览器**保存环节**的行为，桌面 Chrome 的常规断言完全覆盖不到。
    // 只验 `Utils.useNativeDownload()` 返回 true 是不够的：
    // 判定对了、分支走错了，照样失败。
    dlDir = mkdtempSync(join(tmpdir(), 'wxchat-dl-'));
    await send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: dlDir, eventsEnabled: true
    });
    await send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' });
    await send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    // 重新加载，让前端在「移动端 UA」下重新初始化（token 在 localStorage，不必重新登录）
    await send('Page.navigate', { url: `${BASE}/` });
    await waitFor(() => evaluate(`!!window.app && window.app.isInitialized === true`),
      { label: '移动端 UA 下重新初始化', timeout: 20000 });
    check('模拟 Android UA 后 useNativeDownload() 为 true',
      (await evaluate(`Utils.useNativeDownload() === true`)) === true);

    await waitFor(() => evaluate(`document.querySelectorAll('.file-download-btn').length > 0`),
      { label: '文件卡片渲染', timeout: 15000 });

    netRequests.length = 0;
    downloads.length = 0;
    const clicked = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('.file-download-btn')];
      if (!btns.length) return false;
      btns[btns.length - 1].click();
      return true;
    })()`);
    check('点到了真实的下载按钮', clicked === true);

    await sleep(150);
    const mobileToast = await evaluate(
      `(document.querySelector('#toastHost .toast') || {}).textContent || ''`);
    check('移动端提示语不再宣称「下载完成」',
      mobileToast.includes('已开始下载') && !mobileToast.includes('下载完成'),
      `实际「${mobileToast}」`);

    // 最终证据：文件真的出现在磁盘上，且内容正确、文件名正确
    const landed = await waitFor(() => {
      try {
        const files = fs.readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'));
        return files.length ? files : null;
      } catch { return null; }
    }, { label: '移动端下载落盘', timeout: 20000 }).catch(() => []);
    check('移动端点击下载后文件真的落盘', landed.includes('浏览器验证.txt'),
      `实际 ${JSON.stringify(landed)}`);

    const landedBody = landed.includes('浏览器验证.txt')
      ? fs.readFileSync(join(dlDir, '浏览器验证.txt'), 'utf8') : '';
    check('落盘文件内容与上传内容一致', landedBody === '浏览器上传验证内容',
      `实际 ${JSON.stringify(landedBody)}`);

    // 反向对照：必须走 http(s) 直链，且**不能**出现 blob: URL。
    //
    // 这一条才是真正钉住修复的断言。负向验证时发现：
    // 「文件真的落盘」那条**抓不到回归** —— 桌面版 Chrome 即使伪装成 Android UA，
    // 也照样能下载 blob: URL，所以退回旧代码它依然是绿的。
    // 真机上的 WebView 不支持 blob: 下载，桌面 Chrome 却支持，
    // 这个差异决定了：只能断言「走的是哪条路」，不能只断言「文件有没有下来」。
    const dlEvent = downloads.length ? downloads[downloads.length - 1] : null;
    const dlUrl = dlEvent?.url || '';
    check('下载走带 token 的 http 直链（而非 blob:）',
      dlUrl.includes('/api/files/download/') && dlUrl.includes('token='),
      `实际 ${dlUrl ? maskToken(dlUrl) : '未捕获到 downloadWillBegin 事件'}`);
    check('浏览器采纳了服务端给的文件名',
      dlEvent?.suggestedFilename === '浏览器验证.txt',
      `实际 ${JSON.stringify(dlEvent?.suggestedFilename ?? null)}`);
    check('下载 URL 不是 blob: 协议',
      dlUrl !== '' && !dlUrl.startsWith('blob:'),
      `实际协议 ${dlUrl ? `${dlUrl.split(':')[0]}:` : '（未捕获）'}`);

    // 还原桌面环境，避免影响后续小节（清空、连接状态、报错检查）
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setUserAgentOverride', { userAgent: '' });
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Browser.setDownloadBehavior', { behavior: 'default' });
    await send('Page.navigate', { url: `${BASE}/` });
    await waitFor(() => evaluate(`!!window.app && window.app.isInitialized === true`),
      { label: '还原桌面模式', timeout: 20000 });
    check('还原桌面 UA 后 useNativeDownload() 为 false',
      (await evaluate(`Utils.useNativeDownload() === false`)) === true);

    // ---------- 过期 token 不能把应用页面顶掉 ----------
    //
    // 直链是**顶层导航**，不走 fetch，所以拿不到 authMiddleware 的 401 分支。
    // 若带着一个过期 token 去导航，浏览器会把整个应用页面换成服务端返回的 JSON，
    // 用户既没拿到文件、还丢了当前界面 —— 比单纯下载失败糟糕得多。
    // 所以 downloadByDirectLink 必须在发起导航前本地判一次过期。
    const expInfo = await evaluate(`(() => {
      const t = Auth.getToken();
      const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - b.length % 4);
      const d = JSON.parse(decodeURIComponent(escape(atob(b + pad))));
      return { exp: d.exp, isMs: d.exp > 1e12, expired: Auth.isTokenExpired() };
    })()`);
    // exp 必须是**毫秒**：服务端签的是 Date.now()+ms（见 src/worker/auth.js）。
    // 若有人把它当 JWT 标准的「秒」去比较，过期判断会对所有 token 恒为 true ——
    // 移动端下载将彻底不可用。这条断言就是拦这个的。
    check('在线 token 未判为过期，且 exp 是毫秒时间戳',
      expInfo.expired === false && expInfo.isMs === true, JSON.stringify(expInfo));

    const expiredProbe = await evaluate(`(() => {
      const realUnauth = Auth.handleUnauthorized;
      const realClick = HTMLAnchorElement.prototype.click;
      const realToken = Auth.getToken();
      let unauthCalled = false;
      let navigated = false;
      Auth.handleUnauthorized = () => { unauthCalled = true; };
      HTMLAnchorElement.prototype.click = function () { navigated = true; };
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      const expired = b64({ alg: 'HS256', typ: 'JWT' }) + '.'
        + b64({ iat: Date.now() - 7200000, exp: Date.now() - 3600000, type: 'access' }) + '.sig';
      Auth.setToken(expired);
      const detected = Auth.isTokenExpired();
      let msg = '';
      try { API.downloadByDirectLink('files/probe.txt', 'probe.txt'); }
      catch (e) { msg = e.message || String(e); }
      Auth.setToken(realToken);
      Auth.handleUnauthorized = realUnauth;
      HTMLAnchorElement.prototype.click = realClick;
      return { detected, msg, navigated, unauthCalled, restored: Auth.isTokenExpired() };
    })()`);
    check('过期 token 能被本地识别', expiredProbe.detected === true,
      JSON.stringify(expiredProbe));
    check('过期 token 时**不发起**下载导航（不会顶掉应用页面）',
      expiredProbe.navigated === false, JSON.stringify(expiredProbe));
    check('过期 token 时走 handleUnauthorized（回登录页）并抛出明确错误',
      expiredProbe.unauthCalled === true && expiredProbe.msg.includes('登录已过期'),
      `实际 ${JSON.stringify(expiredProbe)}`);
    check('探测后 token 已还原（未污染后续用例）',
      expiredProbe.restored === false, JSON.stringify(expiredProbe));

    check('上传状态条含速度显示元素', await evaluate(`!!document.querySelector('#uploadSpeedText')`));
    check('文件消息渲染为文件卡片', await evaluate(`!!document.querySelector('.file-card')`));

    // ---------- 滑动确认清空 ----------
    section('[6] 滑动确认清空数据');
    // 注意：handleClearCommand 返回的 Promise 要等用户确认才 resolve，
    // 所以这里绝不能 await 它，否则 Runtime.evaluate 会一直挂着。
    await evaluate(`(() => { MessageHandler.handleClearCommand(); return true; })()`, { awaitPromise: false });
    await waitFor(() => evaluate(`!!document.querySelector('.slide-track')`), { label: '滑动确认弹窗出现' });
    check('弹出滑动确认弹窗', true);
    check('弹窗内不再要求输入确认码',
      (await evaluate(`document.querySelectorAll('.slide-confirm .dialog-input').length`)) === 0);

    const slideInfo = await evaluate(`(() => {
      const track = document.querySelector('.slide-track');
      const knob = document.querySelector('.slide-knob');
      const maxX = track.clientWidth - knob.offsetWidth - 4;
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      knob.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 4, clientY: 24 }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: maxX + 20, clientY: 24 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: maxX + 20, clientY: 24 }));
      return { maxX };
    })()`);
    check('滑块可拖拽（轨道宽度有效）', slideInfo.maxX > 0, JSON.stringify(slideInfo));

    const cleared = await waitFor(async () => {
      const total = await evaluate(`(async () => {
        const j = await (await fetch('/api/messages?limit=5000', { headers: Auth.addAuthHeader({}) })).json();
        return j.total;
      })()`);
      return total === 0;
    }, { label: '数据被清空', timeout: 20000 }).catch(() => false);
    check('滑动确认后服务端数据已清空', cleared === true);

    const listEmpty = await waitFor(async () => {
      return await evaluate(`document.querySelectorAll('.message').length === 0`);
    }, { label: '消息列表清空', timeout: 8000 }).catch(() => false);
    check('消息列表已清空', listEmpty === true);

    // ---------- 连接状态文案 ----------
    section('[7] 连接状态文案（智能区分）');
    // 状态横幅有 800ms 防抖（避免网络抖动导致文案闪烁），断言前需要等它落地
    const offlineText = await evaluate(`(async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      UI.setConnectionStatus('connecting');
      await new Promise(r => setTimeout(r, 1000));
      const t = document.querySelector('#connectionBar').textContent;
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      return t;
    })()`);
    check('浏览器离线时不显示「连接中」', offlineText.includes('离线'), `实际「${offlineText}」`);

    await sleep(900);
    const reconnText = await evaluate(`(() => {
      UI.setConnectionStatus('reconnecting');
      return document.querySelector('#connectionBar').textContent;
    })()`);
    check('重连中显示「重连中」', reconnText.includes('重连中'), `实际「${reconnText}」`);

    const onlineHidden = await evaluate(`(() => {
      UI.setConnectionStatus('connected');
      const bar = document.querySelector('#connectionBar');
      return !bar.classList.contains('show') && bar.textContent === '';
    })()`);
    check('在线时横幅隐藏', onlineHidden === true);

    // ---------- 运行时报错 ----------
    section('[8] 运行时报错检查');
    const noisy = /favicon|Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_|Clipboard|clipboard/i;
    const realConsoleErrors = consoleErrors.filter((e) => e && !noisy.test(e));
    const realPageErrors = pageErrors.filter((e) => e && !noisy.test(e));
    check('无未捕获异常', realPageErrors.length === 0, realPageErrors.slice(0, 2).join(' | '));
    check('无控制台 error 输出', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 2).join(' | '));

    console.log(`\n${'='.repeat(62)}`);
    console.log(`浏览器验证结果：通过 ${passed} 项，失败 ${failures.length} 项`);
    if (failures.length) {
      console.log('\n失败明细：');
      failures.forEach((f) => console.log(`  - ${f}`));
    }
    console.log('='.repeat(62));

  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (dlDir) { try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n浏览器验证脚本异常：', err.message);
  process.exit(1);
});
