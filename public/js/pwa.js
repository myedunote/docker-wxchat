/**
 * PWA 管理 v2
 */
class PWAManager {
  constructor() {
    this.deferredPrompt = null;
    this.isInstalled = false;
    this.swRegistration = null;
  }

  async init() {
    try {
      await this.registerServiceWorker();
      this.setupEventListeners();
      this.checkInstallStatus();
      return true;
    } catch (e) {
      console.warn('[PWA] init failed', e);
      return false;
    }
  }

  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      this.swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      this.swRegistration.addEventListener('updatefound', () => {
        const worker = this.swRegistration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            this.showUpdateBanner();
          }
        });
      });
    } catch (e) {
      console.warn('[PWA] SW register failed', e);
    }
  }

  setupEventListeners() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
      this.isInstalled = true;
      this.deferredPrompt = null;
      document.querySelector('.pwa-banner')?.remove();
    });
  }

  checkInstallStatus() {
    this.isInstalled = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  async promptInstall() {
    if (this.isInstalled) {
      UI.showInfo('应用已安装');
      return;
    }
    if (this.deferredPrompt) {
      this.deferredPrompt.prompt();
      const { outcome } = await this.deferredPrompt.userChoice;
      this.deferredPrompt = null;
      UI.showInfo(outcome === 'accepted' ? '安装已开始' : '已取消安装');
      return;
    }
    this.showInstallBanner();
  }

  showInstallBanner() {
    document.querySelector('.pwa-banner')?.remove();
    const el = document.createElement('div');
    el.className = 'pwa-banner';
    el.innerHTML = `
      <div>
        <strong>安装到主屏幕</strong>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">获得更接近原生的体验</div>
      </div>
      <div class="pwa-banner-actions">
        <button type="button" class="btn-ghost" data-act="close">关闭</button>
        <button type="button" class="btn-primary" data-act="install">安装</button>
      </div>
    `;
    el.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (act === 'close') el.remove();
      if (act === 'install') {
        el.remove();
        if (this.deferredPrompt) {
          this.deferredPrompt.prompt();
          await this.deferredPrompt.userChoice;
          this.deferredPrompt = null;
        } else {
          UI.showInfo('请使用浏览器菜单中的“添加到主屏幕”');
        }
      }
    });
    document.querySelector('.app')?.appendChild(el);
  }

  showUpdateBanner() {
    document.querySelector('.pwa-banner')?.remove();
    const el = document.createElement('div');
    el.className = 'pwa-banner';
    el.innerHTML = `
      <div><strong>发现新版本</strong></div>
      <div class="pwa-banner-actions">
        <button type="button" class="btn-ghost" data-act="close">稍后</button>
        <button type="button" class="btn-primary" data-act="refresh">更新</button>
      </div>
    `;
    el.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'close') el.remove();
      if (act === 'refresh') {
        this.swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
        location.reload();
      }
    });
    document.querySelector('.app')?.appendChild(el);
  }
}

const PWA = new PWAManager();
if (typeof window !== 'undefined') window.PWA = PWA;
