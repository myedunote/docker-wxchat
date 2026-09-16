/**
 * 工具函数库 v2
 */
const Utils = {
  generateDeviceId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    return `${CONFIG.DEVICE.ID_PREFIX}${timestamp}-${random}`;
  },

  getDeviceId() {
    try {
      let id = localStorage.getItem(CONFIG.DEVICE.STORAGE_KEY);
      if (!id) {
        id = this.generateDeviceId();
        localStorage.setItem(CONFIG.DEVICE.STORAGE_KEY, id);
      }
      return id;
    } catch {
      return this.generateDeviceId();
    }
  },

  getDeviceType() {
    const ua = navigator.userAgent || '';

    // 常规移动端：Android / iOS / 通用 `Mobi` 标识
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';

    // HarmonyOS NEXT / OpenHarmony（ArkWeb 内核）。官方默认 UA 形如：
    //   Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko)
    //   Chrome/114.0.0.0 Safari/537.36  ArkWeb/4.1.6.1 Mobile
    // 它**不含 `Android`**，而 `Mobile` 只来自 DeviceCompat 这个「前向兼容字段」——
    // 平板与三方 WebView 完全可能没有它。所以上面那条正则兜不住，这是国内存量很大的机型。
    //
    // 官方建议：用 `OpenHarmony` 识别系统，用 DeviceType(`Phone`/`Tablet`/`PC`) 识别形态。
    // 只有 2in1 是桌面形态，其余（含未标明形态的）一律按移动端处理 ——
    // 判错的代价不对称：误判成移动端只少一个进度条，误判成桌面则下载直接失效。
    if (/OpenHarmony|ArkWeb/i.test(ua)) {
      return /\(\s*PC\s*;/i.test(ua) ? 'desktop' : 'mobile';
    }

    return 'desktop';
  },

  getDeviceName() {
    return this.getDeviceType() === 'mobile'
      ? CONFIG.DEVICE.NAME_MOBILE
      : CONFIG.DEVICE.NAME_DESKTOP;
  },

  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  isMobile() {
    return this.getDeviceType() === 'mobile';
  },

  /**
   * 下载是否该交给「浏览器原生下载器」（直链），而不是 Blob + <a download>。
   *
   * 判据是移动端，因为移动端坏的从来不是网络，而是**最后那一步保存**：
   *
   * 1. 大量移动端浏览器其实是 WebView（微信 / QQ / UC / 夸克 / 各家 App 内置），
   *    它们**不支持 blob: URL 下载**。`a.click()` 会被静默忽略 ——
   *    不抛错、不提示、什么都不会发生，前端拿不到任何反馈。
   * 2. Blob 方案必须先把整个文件 await 下来，再 click。等这一步做完，
   *    早已脱离用户手势的 transient activation 窗口（约 5 秒），
   *    Chrome 会把它当成「自动下载」拦掉；`window.open(blobUrl)` 同理会吃弹窗拦截。
   *
   * 直链则把下载交给系统下载器：有通知栏进度、能进「下载」列表、能存进「文件/相册」，
   * 而且**发起时机就在用户点击的同一个 tick 里**，不存在手势过期问题。
   * 代价是前端拿不到进度 —— 这个代价必须付，不能假装还有进度。
   *
   * ⚠ 两个靠 `UA` 本身判不出来的坑，都在 `getDeviceType()` 里补：
   *   1. iPadOS Safari 的 UA 是 `Macintosh`（伪装成桌面），必须用 `isIOS()` 兜底；
   *   2. HarmonyOS NEXT 的 UA 不含 `Android`（见 `getDeviceType()` 注释）。
   *   漏掉任何一个，那批设备都会继续走 Blob 那条死路。
   */
  useNativeDownload() {
    return this.isMobile() || this.isIOS();
  },

  formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((n / Math.pow(k, i)).toFixed(i > 0 ? 2 : 0))} ${sizes[i]}`;
  },

  /**
   * 传输速度格式化：B/s 或 KB/s 或 MB/s
   * 上传/下载进度里实时显示，便于判断是不是卡住了
   */
  formatSpeed(bytesPerSecond) {
    const n = Number(bytesPerSecond) || 0;
    if (n <= 0) return '0 KB/s';
    if (n < 1024) return `${Math.round(n)} B/s`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`;
    return `${(n / 1024 / 1024).toFixed(2)} MB/s`;
  },

  /**
   * 剩余时间估算（秒）；无法估算时返回 null
   */
  estimateRemaining(loaded, total, speed) {
    if (!total || !speed || speed <= 0) return null;
    const rest = total - loaded;
    if (rest <= 0) return 0;
    return Math.round(rest / speed);
  },

  /**
   * 时间显示：统一按「服务端 UTC 时间 + 浏览器本地时区」渲染
   *
   * 服务端（SQLite datetime('now') 与 JS toISOString）存的都是 UTC。
   * 老 Docker 版偏几小时，就是因为把无时区标记的字符串当本地时间 new Date() 了。
   * 这里强制补上 Z，保证任何 TZ 下都显示正确。
   */
  parseTimestamp(timestamp) {
    if (!timestamp) return null;
    if (typeof timestamp === 'number') return new Date(timestamp);
    const s = String(timestamp).trim();
    // 已带时区信息（Z 或 +08:00）就直接解析
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    // SQLite 的 "YYYY-MM-DD HH:MM:SS" 是 UTC，补 Z
    return new Date(s.replace(' ', 'T') + 'Z');
  },

  formatTime(timestamp) {
    if (!timestamp) return '';
    const date = this.parseTimestamp(timestamp);
    if (!date || Number.isNaN(date.getTime())) return String(timestamp);

    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayDiff = Math.round((startOf(now) - startOf(date)) / 86400000);

    if (dayDiff === 0) return hm;
    if (dayDiff === 1) return `昨天 ${hm}`;
    if (dayDiff < 7 && dayDiff > 1) {
      const week = ['日', '一', '二', '三', '四', '五', '六'];
      return `周${week[date.getDay()]} ${hm}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hm}`;
  },

  formatDateSeparator(timestamp) {
    if (!timestamp) return '';
    const date = this.parseTimestamp(timestamp);
    if (!date || Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayDiff = Math.round((startOf(now) - startOf(date)) / 86400000);
    if (dayDiff === 0) return '今天';
    if (dayDiff === 1) return '昨天';
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  },

  getFileIcon(mimeType, fileName = '') {
    if (mimeType) {
      if (CONFIG.FILE_ICONS[mimeType]) return CONFIG.FILE_ICONS[mimeType];
      for (const [prefix, icon] of Object.entries(CONFIG.FILE_ICONS)) {
        if (prefix !== 'default' && prefix.endsWith('/') && mimeType.startsWith(prefix)) {
          return icon;
        }
      }
    }
    const ext = (fileName || '').split('.').pop()?.toLowerCase();
    if (ext && CONFIG.FILE_EXTENSION_ICONS[ext]) return CONFIG.FILE_EXTENSION_ICONS[ext];
    return CONFIG.FILE_ICONS.default;
  },

  isImageFile(mimeType, fileName = '') {
    if (mimeType && mimeType.startsWith('image/')) return true;
    const ext = (fileName || '').split('.').pop()?.toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext);
  },

  escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  },

  debounce(fn, wait = 100) {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  },

  throttle(fn, wait = 100) {
    let last = 0;
    let timer = null;
    return function throttled(...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  },


  /**
   * 微信风格确认框
   * @returns {Promise<string|null>} 输入值；取消返回 null
   */
  confirmDialog({ title = '提示', message = '', confirmText = '确定', cancelText = '取消', danger = false, input = false, inputPlaceholder = '', inputValue = '' } = {}) {
    return new Promise((resolve) => {
      document.querySelector('.dialog-overlay.wx-dialog')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay wx-dialog';
      overlay.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-header"><div class="dialog-title"></div></div>
          <div class="dialog-body">
            <div class="dialog-message"></div>
            ${input ? '<input class="dialog-input" />' : ''}
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn-cancel"></button>
            <button type="button" class="btn-confirm"></button>
          </div>
        </div>
      `;
      overlay.querySelector('.dialog-title').textContent = title;
      overlay.querySelector('.dialog-message').textContent = message;
      const cancelBtn = overlay.querySelector('.btn-cancel');
      const okBtn = overlay.querySelector('.btn-confirm');
      cancelBtn.textContent = cancelText;
      okBtn.textContent = confirmText;
      if (danger) okBtn.classList.add('btn-danger');
      const inputEl = overlay.querySelector('.dialog-input');
      if (inputEl) {
        inputEl.placeholder = inputPlaceholder;
        inputEl.value = inputValue;
      }
      const close = (val) => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 180);
        resolve(val);
      };
      cancelBtn.addEventListener('click', () => close(null));
      okBtn.addEventListener('click', () => close(input ? (inputEl?.value ?? '') : true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));
      setTimeout(() => inputEl?.focus(), 200);
    });
  },

  /**
   * 复制文本到剪贴板
   * navigator.clipboard 在非 HTTPS / 非 localhost 下不可用，
   * 自托管常常是 http://192.168.x.x，所以必须有 execCommand 兜底。
   */
  async copyText(text) {
    const value = String(text ?? '');
    if (!value) return false;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* 继续走兜底 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  },

  /**
   * 微信风格「滑动确认」弹窗
   *
   * 用于清空数据这类不可逆操作：比输入确认码更顺手，又比单纯点「确定」更防误触。
   * 拖到右端才判定为确认；中途松手会弹回起点。
   *
   * @returns {Promise<boolean>} 确认 true / 取消 false
   */
  slideConfirmDialog({
    title = '危险操作',
    message = '',
    slideLabel = '滑动确认',
    cancelText = '取消',
    danger = true
  } = {}) {
    return new Promise((resolve) => {
      document.querySelector('.dialog-overlay.slide-confirm')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay wx-dialog slide-confirm';
      overlay.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-header"><div class="dialog-title"></div></div>
          <div class="dialog-body">
            <div class="dialog-message"></div>
            <div class="slide-track" role="slider"
                 aria-label="${Utils.escapeHtml(slideLabel)}"
                 aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
              <div class="slide-fill"></div>
              <div class="slide-label"></div>
              <div class="slide-knob" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M8.6 16.6 4 12l4.6-4.6L10 8.8 6.8 12 10 15.2l-1.4 1.4zm6.8 0L14 15.2 17.2 12 14 8.8l1.4-1.4L20 12l-4.6 4.6z"/></svg>
              </div>
            </div>
            <div class="slide-hint"></div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn-cancel"></button>
          </div>
        </div>
      `;

      overlay.querySelector('.dialog-title').textContent = title;
      overlay.querySelector('.dialog-message').textContent = message;
      overlay.querySelector('.slide-label').textContent = slideLabel;
      overlay.querySelector('.slide-hint').textContent = CONFIG.CLEAR?.SLIDE_HINT || '按住滑块向右滑动';
      const cancelBtn = overlay.querySelector('.btn-cancel');
      cancelBtn.textContent = cancelText;
      if (danger) overlay.querySelector('.dialog-title').classList.add('danger');

      const track = overlay.querySelector('.slide-track');
      const knob = overlay.querySelector('.slide-knob');
      const fill = overlay.querySelector('.slide-fill');
      const label = overlay.querySelector('.slide-label');

      let dragging = false;
      let startX = 0;
      let maxX = 0;
      let currentX = 0;
      let settled = false;

      const setX = (x) => {
        currentX = Math.max(0, Math.min(maxX, x));
        knob.style.transform = `translateX(${currentX}px)`;
        fill.style.width = `${currentX + knob.offsetWidth}px`;
        const pct = maxX > 0 ? Math.round((currentX / maxX) * 100) : 0;
        track.setAttribute('aria-valuenow', String(pct));
        label.style.opacity = String(Math.max(0, 1 - currentX / (maxX || 1) * 1.6));
      };

      const measure = () => {
        maxX = Math.max(0, track.clientWidth - knob.offsetWidth - 4);
      };

      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        close(confirmed);
      };

      const close = (value) => {
        overlay.classList.remove('show');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        window.removeEventListener('resize', measure);
        setTimeout(() => overlay.remove(), 180);
        resolve(value);
      };

      const onDown = (e) => {
        if (settled) return;
        measure();
        dragging = true;
        startX = e.clientX - currentX;
        knob.classList.add('dragging');
        // 合成事件或已释放的 pointerId 会让 setPointerCapture 抛 NotFoundError，
        // 捕获失败不影响拖拽逻辑本身（move/up 都挂在 document 上）
        try { knob.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!dragging || settled) return;
        setX(e.clientX - startX);
        // 拖到头直接判定确认，不需要松手
        if (maxX > 0 && currentX >= maxX - 1) finish(true);
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        knob.classList.remove('dragging');
        if (!settled) {
          // 没拖到底：弹回起点
          knob.style.transition = 'transform .22s ease';
          setX(0);
          setTimeout(() => { knob.style.transition = ''; }, 240);
        }
      };

      knob.addEventListener('pointerdown', onDown);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      window.addEventListener('resize', measure);

      // 键盘可达性：右方向键推到尽头 = 确认
      track.addEventListener('keydown', (e) => {
        if (settled) return;
        measure();
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setX(currentX + Math.max(24, maxX / 5));
          if (currentX >= maxX - 1) finish(true);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          finish(true);
        }
      });

      cancelBtn.addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

      document.body.appendChild(overlay);
      requestAnimationFrame(() => {
        overlay.classList.add('show');
        measure();
        setX(0);
      });
    });
  },

  showToast(message, type = 'info', duration = CONFIG.UI.TOAST_DURATION) {
    const host = document.getElementById('toastHost');
    if (!host || !message) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 160);
    }, duration);
  },

  // 兼容旧调用
  showNotification(message, type = 'info') {
    this.showToast(message, type);
  },

  markdown: {
    hasMarkdownSyntax(text) {
      if (!text) return false;
      return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|```|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)/.test(text);
    },

    renderToHtml(text) {
      if (!text) return '';
      try {
        if (typeof marked !== 'undefined') {
          marked.setOptions({
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false
          });
          // 基础消毒：去掉 script/on* 属性
          let html = marked.parse(String(text));
          html = html
            .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
            .replace(/\son\w+="[^"]*"/gi, '')
            .replace(/\son\w+='[^']*'/gi, '')
            .replace(/javascript:/gi, '');
          return html;
        }
      } catch (e) {
        console.warn('[Utils] markdown render failed', e);
      }
      return Utils.escapeHtml(text).replace(/\n/g, '<br>');
    }
  },

  storage: {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
  },

  haptic(type = 'light') {
    try {
      if (!navigator.vibrate) return;
      if (type === 'success') navigator.vibrate([10, 30, 10]);
      else if (type === 'error') navigator.vibrate([30, 40, 30]);
      else navigator.vibrate(12);
    } catch { /* ignore */ }
  },

  initViewportFix() {
    const setVh = () => {
      const h = window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--vh', `${h * 0.01}px`);
    };
    setVh();
    window.addEventListener('resize', setVh);
    window.visualViewport?.addEventListener('resize', setVh);
    window.visualViewport?.addEventListener('scroll', setVh);

    // 键盘检测
    if (window.visualViewport) {
      let base = window.visualViewport.height;
      window.visualViewport.addEventListener('resize', () => {
        const h = window.visualViewport.height;
        if (h < base - 120) {
          document.body.classList.add('keyboard-open');
        } else {
          document.body.classList.remove('keyboard-open');
          base = Math.max(base, h);
        }
      });
    }
  }
};

if (typeof window !== 'undefined') window.Utils = Utils;
