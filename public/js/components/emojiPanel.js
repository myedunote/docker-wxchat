/**
 * 完整表情面板 — 微信式内嵌
 */
const EmojiPanel = {
  activeGroup: 'recent',
  isInitialized: false,

  init() {
    if (this.isInitialized) return true;
    this.renderTabs();
    this.renderGroup(this.activeGroup);
    this.bindEvents();
    this.isInitialized = true;
    return true;
  },

  bindEvents() {
    document.getElementById('emojiTabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.emoji-tab');
      if (!tab) return;
      this.activeGroup = tab.dataset.group;
      this.renderTabs();
      this.renderGroup(this.activeGroup);
    });

    document.getElementById('emojiScroll')?.addEventListener('click', (e) => {
      const cell = e.target.closest('.emoji-cell');
      if (!cell) return;
      this.insert(cell.dataset.emoji);
    });
  },

  renderTabs() {
    const host = document.getElementById('emojiTabs');
    if (!host || !window.EMOJI_DATA) return;
    const tabs = [
      { id: 'recent', name: '最近' },
      ...EMOJI_DATA.groups.map((g) => ({ id: g.id, name: g.name }))
    ];
    host.innerHTML = tabs.map((t) => `
      <button type="button" class="emoji-tab ${t.id === this.activeGroup ? 'active' : ''}"
        data-group="${t.id}" role="tab" aria-selected="${t.id === this.activeGroup}">${t.name}</button>
    `).join('');
  },

  renderGroup(groupId) {
    const host = document.getElementById('emojiScroll');
    if (!host || !window.EMOJI_DATA) return;

    let list = [];
    let title = '';
    if (groupId === 'recent') {
      list = EMOJI_DATA.getRecent();
      title = '最近使用';
      if (!list.length) {
        // 默认推荐
        list = EMOJI_DATA.groups[0].list.slice(0, 24);
        title = '推荐表情';
      }
    } else {
      const g = EMOJI_DATA.groups.find((x) => x.id === groupId);
      list = g?.list || [];
      title = g?.name || '';
    }

    host.innerHTML = `
      <div class="emoji-section-title">${title}</div>
      <div class="emoji-grid">
        ${list.map((e) => `<button type="button" class="emoji-cell" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}
      </div>
    `;
  },

  insert(emoji) {
    if (!emoji) return;
    EMOJI_DATA.pushRecent(emoji);
    const ta = document.getElementById('messageText');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const next = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    ta.value = next;
    ta.focus();
    const pos = start + emoji.length;
    try { ta.setSelectionRange(pos, pos); } catch { /* ignore */ }
    UI.autoResizeTextarea();
    UI.checkInputAndToggleSendButton();
    EventBus?.emit?.('emoji:inserted', { emoji });
  },

  show() {
    this.init();
    const dock = document.getElementById('panelDock');
    const emoji = document.getElementById('emojiPanel');
    const plus = document.getElementById('plusPanel');
    if (!dock || !emoji) return;
    plus && (plus.hidden = true);
    emoji.hidden = false;
    dock.hidden = false;
    requestAnimationFrame(() => {
      dock.classList.add('open', 'tall');
    });
    document.getElementById('emojiButton')?.classList.add('active');
    document.getElementById('emojiButton')?.setAttribute('aria-expanded', 'true');
    document.getElementById('functionButton')?.classList.remove('open');
    document.getElementById('functionButton')?.setAttribute('aria-expanded', 'false');
    // 收起键盘后展示
    document.getElementById('messageText')?.blur();
    UI.scrollToBottom(true);
    EventBus?.emit?.('panel:open', { panel: 'emoji' });
  },

  hide() {
    const dock = document.getElementById('panelDock');
    const emoji = document.getElementById('emojiPanel');
    if (!dock) return;
    dock.classList.remove('open', 'tall');
    document.getElementById('emojiButton')?.classList.remove('active');
    document.getElementById('emojiButton')?.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!dock.classList.contains('open')) {
        if (emoji) emoji.hidden = true;
        if (!document.getElementById('plusPanel') || document.getElementById('plusPanel').hidden) {
          dock.hidden = true;
        }
      }
    }, 280);
  },

  isOpen() {
    const emoji = document.getElementById('emojiPanel');
    const dock = document.getElementById('panelDock');
    return !!(dock?.classList.contains('open') && emoji && !emoji.hidden);
  },

  toggle() {
    if (this.isOpen()) this.hide();
    else {
      // 互斥关闭 plus
      FunctionMenu?.hide?.();
      this.show();
    }
  }
};

if (typeof window !== 'undefined') window.EmojiPanel = EmojiPanel;
