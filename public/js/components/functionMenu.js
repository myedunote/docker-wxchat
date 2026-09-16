/**
 * 功能宫格 — 输入区内嵌（微信 + 面板）
 */
const FunctionMenu = {
  menuItems: [
    { id: 'photo', icon: '📷', title: '拍摄', action: 'photo' },
    { id: 'album', icon: '🖼️', title: '相册', action: 'album' },
    { id: 'file', icon: '📁', title: '文件', action: 'file' },
    { id: 'search', icon: '🔍', title: '搜索', action: 'search' },
    { id: 'ai-chat', icon: '🤖', title: 'AI助手', action: 'aiChat' },
    { id: 'ai-image-gen', icon: '🎨', title: 'AI绘画', action: 'aiImageGen' },
    { id: 'clear-chat', icon: '🧹', title: '清理记录', action: 'clearChat' },
    { id: 'pwa-manage', icon: '📱', title: '添加到主屏', action: 'pwaManage' },
    { id: 'logout', icon: '🚪', title: '登出', action: 'logout' }
  ],
  isInitialized: false,

  init() {
    if (this.isInitialized) return true;
    this.renderGrid();
    this.bindEvents();
    this.isInitialized = true;
    return true;
  },

  renderGrid() {
    const grid = document.getElementById('functionGrid');
    if (!grid) return;
    grid.innerHTML = this.menuItems.map((item) => {
      // AI 相关入口在服务端未配置密钥时置灰并标注原因，
      // 否则用户点了会「看起来启用了、一发送就失败」，很容易误判成功能缺失。
      const reason = this.unavailableReason(item.action);
      return `
      <button type="button"
              class="function-item${reason ? ' is-disabled' : ''}"
              data-action="${item.action}"
              data-id="${item.id}"
              ${reason ? `data-unavailable="${reason}" aria-disabled="true"` : ''}>
        <div class="function-item-icon">${item.icon}</div>
        <div class="function-item-title">${item.title}</div>
        ${reason ? '<div class="function-item-badge">未配置</div>' : ''}
      </button>`;
    }).join('');
  },

  /** 返回不可用原因；可用则返回 null */
  unavailableReason(action) {
    if (typeof ServerConfig === 'undefined') return null;
    if (action === 'aiChat' && !ServerConfig.aiEnabled()) {
      return '未配置 AI：请在 .env 中填写 AI_API_KEY 后重启服务';
    }
    if (action === 'aiImageGen' && !ServerConfig.imageGenEnabled()) {
      return '未配置 AI 绘画：请在 .env 中填写 IMAGE_GEN_API_KEY 或 AI_API_KEY 后重启服务';
    }
    return null;
  },

  bindEvents() {
    document.getElementById('functionGrid')?.addEventListener('click', (e) => {
      const item = e.target.closest('.function-item');
      if (!item) return;
      const reason = item.dataset.unavailable;
      if (reason) {
        UI.showError(reason);
        this.hide();
        return;
      }
      this.executeAction(item.dataset.action, item.dataset.id);
      // 选择后收起（登出/清理除外也可收）
      this.hide();
    });
  },

  show() {
    this.init();
    const dock = document.getElementById('panelDock');
    const plus = document.getElementById('plusPanel');
    const emoji = document.getElementById('emojiPanel');
    if (!dock || !plus) return;
    if (emoji) emoji.hidden = true;
    plus.hidden = false;
    dock.hidden = false;
    requestAnimationFrame(() => {
      dock.classList.add('open');
      dock.classList.remove('tall');
    });
    document.getElementById('functionButton')?.classList.add('open');
    document.getElementById('functionButton')?.setAttribute('aria-expanded', 'true');
    document.getElementById('emojiButton')?.classList.remove('active');
    document.getElementById('emojiButton')?.setAttribute('aria-expanded', 'false');
    document.getElementById('messageText')?.blur();
    UI.scrollToBottom(true);
    EventBus?.emit?.('panel:open', { panel: 'plus' });
  },

  hide() {
    const dock = document.getElementById('panelDock');
    const plus = document.getElementById('plusPanel');
    if (!dock) return;
    dock.classList.remove('open', 'tall');
    document.getElementById('functionButton')?.classList.remove('open');
    document.getElementById('functionButton')?.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!dock.classList.contains('open')) {
        if (plus) plus.hidden = true;
        const emoji = document.getElementById('emojiPanel');
        if (!emoji || emoji.hidden) dock.hidden = true;
      }
    }, 280);
    EventBus?.emit?.('panel:close', { panel: 'plus' });
  },

  isOpen() {
    const plus = document.getElementById('plusPanel');
    const dock = document.getElementById('panelDock');
    return !!(dock?.classList.contains('open') && plus && !plus.hidden);
  },

  toggle() {
    if (this.isOpen()) this.hide();
    else {
      EmojiPanel?.hide?.();
      this.show();
    }
  },

  executeAction(action) {
    EventBus?.emit?.('function:action', { action });
    switch (action) {
      case 'photo':
        FileUpload.openCamera();
        break;
      case 'album':
        FileUpload.openAlbum();
        break;
      case 'file':
        FileUpload.openFiles();
        break;
      case 'search':
        window.SearchUI?.showSearchModal?.();
        break;
      case 'aiChat':
        window.AIHandler?.toggleAIMode?.();
        break;
      case 'aiImageGen':
        window.ImageGenUI?.show?.();
        break;
      case 'clearChat':
        MessageHandler.handleClearCommand();
        break;
      case 'pwaManage':
        window.PWA?.promptInstall?.();
        break;
      case 'logout':
        Auth.logout();
        break;
      default:
        break;
    }
  }
};

if (typeof window !== 'undefined') window.FunctionMenu = FunctionMenu;
