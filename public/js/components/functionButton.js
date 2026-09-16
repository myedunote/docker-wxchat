/**
 * 输入区按钮编排：表情 / + / 搜索 / 更多
 */
const FunctionButton = {
  init() {
    const plusBtn = document.getElementById('functionButton');
    const emojiBtn = document.getElementById('emojiButton');
    const searchBtn = document.getElementById('searchNavBtn');
    const moreBtn = document.getElementById('moreNavBtn');
    const ta = document.getElementById('messageText');

    plusBtn?.addEventListener('click', () => {
      FunctionMenu.toggle();
    });

    emojiBtn?.addEventListener('click', () => {
      EmojiPanel.toggle();
    });

    searchBtn?.addEventListener('click', () => {
      this.closePanels();
      window.SearchUI?.showSearchModal?.();
    });

    moreBtn?.addEventListener('click', () => {
      this.closePanels();
      this.showMoreSheet();
    });

    document.getElementById('aiModeCloseBtn')?.addEventListener('click', () => {
      if (window.AIHandler?.isAIMode) AIHandler.toggleAIMode();
    });

    // 聚焦输入时收起面板（更像微信）
    ta?.addEventListener('focus', () => {
      // 轻微延迟，避免点按钮时抢焦点
      setTimeout(() => {
        if (document.activeElement === ta) this.closePanels();
      }, 50);
    });

    // 点击消息列表收起
    document.getElementById('messageList')?.addEventListener('click', () => {
      this.closePanels();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePanels();
    });

    return true;
  },

  closePanels() {
    FunctionMenu?.hide?.();
    EmojiPanel?.hide?.();
  },

  showMoreSheet() {
    // 简易更多菜单：设备信息 / 登出
    document.querySelector('.context-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.right = '12px';
    menu.style.left = 'auto';
    menu.style.top = `calc(var(--safe-top) + var(--nav-height) + 8px)`;
    menu.innerHTML = `
      <button type="button" class="context-menu-item" data-act="search">搜索聊天记录</button>
      <button type="button" class="context-menu-item" data-act="pwa">安装应用</button>
      <button type="button" class="context-menu-item" data-act="clear">清理数据</button>
      <button type="button" class="context-menu-item danger" data-act="logout">退出登录</button>
    `;
    menu.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      menu.remove();
      if (act === 'search') SearchUI?.showSearchModal?.();
      if (act === 'pwa') PWA?.promptInstall?.();
      if (act === 'clear') MessageHandler.handleClearCommand();
      if (act === 'logout') Auth.logout();
    });
    document.body.appendChild(menu);
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== document.getElementById('moreNavBtn')) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }
};

if (typeof window !== 'undefined') window.FunctionButton = FunctionButton;
