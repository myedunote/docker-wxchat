/**
 * 应用入口 v3
 */
class WeChatApp {
  constructor() {
    this.isInitialized = false;
    this.deviceId = null;
  }

  async init() {
    try {
      Utils.initViewportFix();
      Auth.init();

      const isAuthenticated = await Auth.checkAuthentication();
      if (!isAuthenticated) {
        window.location.href = '/login.html';
        return;
      }

      this.deviceId = Utils.getDeviceId();

      // 先拿到服务端下发的可配置项（上传上限 / 加载条数 / 清空确认策略 / AI 开关），
      // 再启动各模块，避免前端拿着过期默认值跑起来
      await ServerConfig.load();

      this.bindGlobalEvents();
      this.bootstrapModules();
      this.isInitialized = true;
      EventBus?.emit?.('app:ready', { deviceId: this.deviceId });
    } catch (e) {
      console.error('[App] init failed', e);
      Utils.showToast('应用初始化失败', 'error');
    }
  }

  bindGlobalEvents() {
    window.addEventListener('online', () => {
      EventBus?.emit?.('network:online');
      // 网络刚恢复时是「重连中」，不是首次「连接中」
      UI.setConnectionStatus('reconnecting');
    });
    window.addEventListener('offline', () => {
      EventBus?.emit?.('network:offline');
      UI.setConnectionStatus('offline');
      Utils.showToast('网络已断开', 'error');
    });
  }

  bootstrapModules() {
    const safeInit = (name, mod, fn) => {
      try {
        if (!mod) {
          console.warn(`[App] module missing: ${name}`);
          return false;
        }
        const result = fn ? fn(mod) : (typeof mod.init === 'function' ? mod.init() : true);
        window[name] = mod;
        return result !== false;
      } catch (e) {
        console.error(`[App] init ${name} failed`, e);
        return false;
      }
    };

    UI.init();
    safeInit('EmojiPanel', typeof EmojiPanel !== 'undefined' ? EmojiPanel : null);
    safeInit('FunctionMenu', typeof FunctionMenu !== 'undefined' ? FunctionMenu : null);
    safeInit('FunctionButton', typeof FunctionButton !== 'undefined' ? FunctionButton : null);
    safeInit('FileUpload', typeof FileUpload !== 'undefined' ? FileUpload : null);
    safeInit('PWA', typeof PWA !== 'undefined' ? PWA : null);
    safeInit('AIUI', typeof AIUI !== 'undefined' ? AIUI : null);
    safeInit('AIHandler', typeof AIHandler !== 'undefined' ? AIHandler : null);
    safeInit('ImageGenUI', typeof ImageGenUI !== 'undefined' ? ImageGenUI : null);
    safeInit('ImageGenHandler', typeof ImageGenHandler !== 'undefined' ? ImageGenHandler : null);
    safeInit('SearchUI', typeof SearchUI !== 'undefined' ? SearchUI : null);
    safeInit('SearchHandler', typeof SearchHandler !== 'undefined' ? SearchHandler : null);

    MessageHandler.init();

    // URL action 快捷方式
    const action = new URLSearchParams(location.search).get('action');
    if (action === 'file') setTimeout(() => FileUpload?.openFiles?.(), 300);
    if (action === 'search') setTimeout(() => SearchUI?.showSearchModal?.(), 300);

    window.addEventListener('beforeunload', () => {
      API.clearImageBlobCache?.();
      Realtime?.disconnect?.(true);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new WeChatApp();
  window.app = app;
  app.init();
});
