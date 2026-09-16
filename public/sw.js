/* wxchat service worker (docker-wxchat)
 *
 * ⚠ 发布纪律：只要 PRECACHE 列表里的任一静态资源内容有改动，
 *   必须递增下面的 CACHE_NAME，否则老用户拿不到修复。
 *
 *   原因：静态资源走 cache-first（见文件末尾的 fetch 处理），
 *   而浏览器的 SW 更新检查只在 **sw.js 文件内容变化** 时才触发 updatefound。
 *   如果改了 base.css / functionMenu.js 却没动 sw.js，已安装 SW 的浏览器
 *   会继续命中旧缓存，刷新一次也看不到变化 —— 很容易被误判成「修了没用」。
 *
 *   命名：与 package.json 的 version 对齐；同一版本内多次改资源就追加 -1 / -2。
 *   当前对应 docker-wxchat v2.0.1。
 */
const CACHE_NAME = 'wxchat-static-2.0.1-3';
const PRECACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/manifest.json',
  '/css/variables.css',
  '/css/base.css',
  '/css/layout.css',
  '/css/messages.css',
  '/css/input.css',
  '/css/modals.css',
  '/css/mobile.css',
  '/css/auth-page.css',
  '/css/docker-ux.css',
  '/js/config.js',
  '/js/components/emojiPanel.js',
  '/js/core/emojiData.js',
  '/js/core/eventBus.js',
  '/js/utils.js',
  '/js/auth.js',
  '/js/api.js',
  '/js/serverConfig.js',
  '/js/ui.js',
  '/js/ui/messageRenderer.js',
  '/js/ui/markdownHandler.js',
  '/js/ui/imageLoader.js',
  '/js/fileUpload.js',
  '/js/realtime.js',
  '/js/messageHandler.js',
  '/js/pwa.js',
  '/js/components/functionMenu.js',
  '/js/components/functionButton.js',
  '/js/ai/aiAPI.js',
  '/js/ai/aiUI.js',
  '/js/ai/aiHandler.js',
  '/js/imageGen/imageGenAPI.js',
  '/js/imageGen/imageGenUI.js',
  '/js/imageGen/imageGenHandler.js',
  '/js/search/searchAPI.js',
  '/js/search/searchUI.js',
  '/js/search/searchHandler.js',
  '/js/app.js',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API 网络优先，不缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({
      success: false,
      error: '离线不可用'
    }), { headers: { 'Content-Type': 'application/json' }, status: 503 })));
    return;
  }

  // 静态资源：缓存优先，回落网络
  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetched = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fetched;
      })
    );
  }
});
