/**
 * 用本机 Chrome（CDP）跑一遍真实 UI 的 AI 对话流程：
 *   登录 → 点 + → 点「AI助手」→ 输入 → 发送 → 等 AI 流式回复 → 截图
 *
 * 用法：
 *   BASE=http://127.0.0.1:18091 ACCESS_PASSWORD=xxx node scripts/ui-check-ai-flow.mjs
 * 产出：
 *   .tmp-e2e/ai-flow/1-function-menu.png
 *   .tmp-e2e/ai-flow/2-ai-mode.png
 *   .tmp-e2e/ai-flow/3-ai-reply.png
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:18091';
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const OUT_DIR = process.env.OUT_DIR || '.tmp-e2e/ai-flow';
const PORT = 19355;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) throw new Error('未找到本机 Chrome/Edge');

const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-'));
let child;
let ws;
let id = 1;
const pending = new Map();
const pageErrors = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, 60000);
  });

const evalx = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};

const waitFor = async (expr, { timeout = 25000, label = expr } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalx(expr)) return true; } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor 超时: ' + label);
};

const shot = async (name) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT_DIR, name);
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log('  截图:', p);
  return p;
};

try {
  child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--headless=new', '--window-size=430,880',
    '--proxy-bypass-list=127.0.0.1;localhost;::1',
    'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  let ver;
  while (Date.now() - t0 < 20000) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!ver) throw new Error('Chrome 调试端口未就绪');
  console.log('Chrome:', ver.Browser);

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || '(unknown)');
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n[1] 打开并登录', BASE);
  await send('Page.navigate', { url: BASE });
  await waitFor(`document.readyState === 'complete'`, { label: 'readyState' });
  await new Promise((r) => setTimeout(r, 800));
  if (await evalx(`!!document.querySelector('#passwordInput')`)) {
    await evalx(`(()=>{const i=document.querySelector('#passwordInput');
      i.value=${JSON.stringify(PASSWORD)};
      i.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#loginButton').click(); return true;})()`);
    await waitFor(`!document.querySelector('#passwordInput')`, { label: '登录完成' });
  }
  await waitFor(`document.querySelector('#functionButton') !== null`, { label: '聊天页就绪' });
  await new Promise((r) => setTimeout(r, 1000));

  const EXPECT_NO_AI = process.env.EXPECT_NO_AI === '1';

  console.log('\n[2] 点 + 打开功能宫格');
  await evalx(`document.querySelector('#functionButton').click(); true`);
  await waitFor(`!document.querySelector('#plusPanel').hidden`, { label: '宫格展开' });
  await new Promise((r) => setTimeout(r, 700));
  await shot('1-function-menu.png');
  const items = JSON.parse(await evalx(`JSON.stringify([...document.querySelectorAll('#functionGrid .function-item')]
    .map(b=>({a:b.dataset.action, t:b.querySelector('.function-item-title')?.textContent,
              disabled:b.getAttribute('aria-disabled')==='true', reason:b.dataset.unavailable||''})))`));
  console.log('  宫格:');
  items.forEach((i) => console.log(`   ${i.t}${i.disabled ? '  [已置灰] ' + i.reason : ''}`));
  const hasAI = items.some((i) => i.a === 'aiChat');
  console.log('  ' + (hasAI ? '✓' : '✗') + ' 宫格里有「AI助手」');
  const emojiHidden = await evalx(`document.querySelector('#emojiPanel').hidden && getComputedStyle(document.querySelector('#emojiPanel')).display === 'none'`);
  console.log('  ' + (emojiHidden ? '✓' : '✗') + ' 表情面板已真正隐藏（不再遮挡宫格）');

  const aiItem = items.find((i) => i.a === 'aiChat');
  const greyOk = EXPECT_NO_AI ? aiItem?.disabled === true : aiItem?.disabled === false;
  console.log('  ' + (greyOk ? '✓' : '✗') + ` AI助手置灰状态符合预期（disabled=${aiItem?.disabled}）`);

  // [2b] 反向回归：表情面板本身必须仍然可用（[hidden] 规则改动最容易误伤它）
  console.log('\n[2b] 点 😊 确认表情面板仍能正常打开');
  await evalx(`document.querySelector('#functionButton').click(); true`); // 先收起宫格
  await new Promise((r) => setTimeout(r, 500));
  await evalx(`document.querySelector('#emojiButton').click(); true`);
  await new Promise((r) => setTimeout(r, 700));
  const emojiState = JSON.parse(await evalx(`(()=>{const e=document.querySelector('#emojiPanel'),p=document.querySelector('#plusPanel');
    return JSON.stringify({emojiDisplay:getComputedStyle(e).display, emojiH:e.offsetHeight,
      plusDisplay:getComputedStyle(p).display, plusH:p.offsetHeight,
      tabs:document.querySelectorAll('#emojiTabs .emoji-tab').length});})()`));
  console.log('  ' + JSON.stringify(emojiState));
  const emojiWorks = emojiState.emojiDisplay !== 'none' && emojiState.emojiH > 0 && emojiState.tabs > 0;
  const plusHidden = emojiState.plusDisplay === 'none' && emojiState.plusH === 0;
  console.log('  ' + (emojiWorks ? '✓' : '✗') + ' 表情面板正常展开（有 tab、有高度）');
  console.log('  ' + (plusHidden ? '✓' : '✗') + ' 功能宫格已让位（不再与表情面板叠在一起）');
  await shot('1b-emoji-panel.png');
  await evalx(`document.querySelector('#emojiButton').click(); true`); // 收起
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n[3] 点「AI助手」');
  await evalx(`document.querySelector('#functionGrid .function-item[data-action="aiChat"]').click(); true`);
  await new Promise((r) => setTimeout(r, 900));

  const aiMode = await evalx(`!!window.AIHandler?.isAIMode`);

  if (EXPECT_NO_AI) {
    // 未配置：预期不进入 AI 模式，而是弹出「去哪里补配置」的提示
    const toast = await evalx(`(()=>{const el=document.querySelector('.toast,[class*="toast"]');
      return el ? el.textContent.trim() : '(未找到提示元素)';})()`);
    console.log('  提示内容:', toast);
    console.log('  ' + (aiMode === false ? '✓' : '✗') + ' 未进入 AI 模式（isAIMode=' + aiMode + '）');
    console.log('  ' + (/AI_API_KEY/.test(toast) ? '✓' : '✗') + ' 提示里给出了具体要填的变量名');
    await shot('2-ai-disabled-hint.png');
  } else {
    console.log('  ' + (aiMode ? '✓' : '✗') + ' AIHandler.isAIMode = ' + aiMode);
    await shot('2-ai-mode.png');
  }

  console.log('\n[4] 发送一句，观察结果');
  await evalx(`(()=>{const ta=document.querySelector('#messageText');
    ta.value='用一句话介绍你自己'; ta.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#sendButton').click(); return true;})()`);

  let hasReply = false;

  if (EXPECT_NO_AI) {
    // 未配置且未进入 AI 模式：这句应当被当作**普通消息**正常发出（这是正确行为）
    await new Promise((r) => setTimeout(r, 2000));
    const msgs0 = JSON.parse(await evalx(`JSON.stringify([...document.querySelectorAll('#messageList .message')].map(m=>({
      cls: m.className, text: (m.querySelector('.text-message')?.textContent || '').trim().slice(0,60)})))`));
    console.log('  消息列表:');
    msgs0.forEach((m, i) => console.log(`   ${i + 1}. [${m.cls}] ${m.text}`));
    const noAiBubble = !msgs0.some((m) => m.cls.includes('ai'));
    const normalSent = msgs0.some((m) => m.cls.includes('own') && m.text);
    console.log('  ' + (noAiBubble ? '✓' : '✗') + ' 未产生 AI 回复气泡');
    console.log('  ' + (normalSent ? '✓' : '✗') + ' 消息作为普通消息正常发出');
    hasReply = noAiBubble && normalSent;
    await shot('3-no-ai-normal-send.png');
  } else {
    await waitFor(`document.querySelectorAll('#messageList .message').length >= 2`, { timeout: 25000, label: '出现 AI 回复' });
    await new Promise((r) => setTimeout(r, 1500));
    const msgs = JSON.parse(await evalx(`JSON.stringify([...document.querySelectorAll('#messageList .message')].map(m=>({
      cls: m.className,
      text: (m.querySelector('.text-message')?.textContent || '').trim().slice(0,80)
    })))`));
    console.log('  消息列表:');
    msgs.forEach((m, i) => console.log(`   ${i + 1}. [${m.cls}] ${m.text}`));
    hasReply = msgs.some((m) => m.cls.includes('ai') && m.text);
    console.log('  ' + (hasReply ? '✓' : '✗') + ' 页面上出现了 AI 回复气泡');
    await shot('3-ai-reply.png');
  }

  // [4b] AI 绘画：走完整弹窗流程，验证「生成 → 下载 → 落库为文件消息」
  let imageOk = true;
  if (!EXPECT_NO_AI) {
    console.log('\n[4b] AI 绘画（弹窗 → 生成 → 入库）');
    const before = await evalx(`document.querySelectorAll('#messageList .message').length`);

    await evalx(`document.querySelector('#functionButton').click(); true`);
    await waitFor(`!document.querySelector('#plusPanel').hidden`, { label: '宫格展开' });
    await new Promise((r) => setTimeout(r, 500));
    await evalx(`document.querySelector('#functionGrid .function-item[data-action="aiImageGen"]').click(); true`);

    await waitFor(`!!document.querySelector('.image-gen-overlay #igPrompt')`, { label: '生图弹窗出现' });
    await new Promise((r) => setTimeout(r, 500));
    const fields = JSON.parse(await evalx(`JSON.stringify({
      prompt: !!document.querySelector('#igPrompt'),
      negative: !!document.querySelector('#igNegative'),
      size: [...document.querySelectorAll('#igSize option')].map(o=>o.value),
      steps: document.querySelector('#igSteps')?.value,
      guidance: document.querySelector('#igGuidance')?.value
    })`));
    console.log('  弹窗字段:', JSON.stringify(fields));
    console.log('  ' + (fields.prompt && fields.negative ? '✓' : '✗') + ' 提示词/反向提示词输入框存在');
    console.log('  ' + (fields.size?.length === 4 ? '✓' : '✗') + ` 尺寸选项 ${fields.size?.length} 个`);
    await shot('4-imagegen-dialog.png');

    await evalx(`(()=>{const t=document.querySelector('#igPrompt');
      t.value='一只在敲代码的猫'; t.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#igSubmit').click(); return true;})()`);

    // 生成成功后应新增一条含图片的文件消息
    await waitFor(`document.querySelectorAll('#messageList .message').length > ${before}`,
      { timeout: 30000, label: '生图结果落库' });
    await new Promise((r) => setTimeout(r, 1200));

    const after = await evalx(`document.querySelectorAll('#messageList .message').length`);
    const hasImg = await evalx(`!!document.querySelector('#messageList .message img')`);
    const overlayGone = await evalx(`!document.querySelector('.image-gen-overlay')`);
    console.log(`  消息数 ${before} → ${after}`);
    console.log('  ' + (after > before ? '✓' : '✗') + ' 新增了一条消息');
    console.log('  ' + (hasImg ? '✓' : '✗') + ' 新消息里渲染出了图片');
    console.log('  ' + (overlayGone ? '✓' : '✗') + ' 提交后弹窗已关闭');
    imageOk = after > before && hasImg && overlayGone;
    await shot('5-imagegen-result.png');
  }

  console.log('\n[5] 页面运行时报错');
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  if (real.length) real.forEach((e) => console.log('  ✗', String(e).split('\n')[0]));
  else console.log('  无');

  // [6] 全局不变量：带 hidden 属性的元素必须真的不可见。
  // 作者样式里的 display 会压过 UA 的 [hidden]{display:none}，
  // 一旦有人给某个可隐藏元素写了 display，就会出现「设了 hidden 却还占位/还显示」的幽灵 UI。
  // 这条断言把整类 bug 一次性兜住，比逐个排查可靠。
  console.log('\n[6] 不变量：所有 [hidden] 元素都必须真的不可见');
  const ghosts = JSON.parse(await evalx(`JSON.stringify(
    [...document.querySelectorAll('[hidden]')]
      .filter(el => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      })
      .map(el => ({ id: el.id || null, cls: el.className || null, tag: el.tagName,
                    display: getComputedStyle(el).display, h: el.offsetHeight }))
  )`));
  if (ghosts.length === 0) {
    console.log('  ✓ 没有「设了 hidden 却仍然可见」的元素');
  } else {
    ghosts.forEach((g) => console.log(`  ✗ ${g.tag}#${g.id}.${g.cls} display=${g.display} h=${g.h}`));
  }
  const noGhosts = ghosts.length === 0;

  const ok = hasAI && emojiHidden && greyOk && emojiWorks && plusHidden && noGhosts && imageOk
    && (EXPECT_NO_AI ? !aiMode : aiMode && hasReply);
  console.log('\n=== ' + (ok ? '全部通过' : '存在失败项') + ' ===');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
