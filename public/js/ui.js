/**
 * UI 主模块 v2
 */
const UI = {
  elements: {},
  messageCache: new Map(),
  lastDateLabel: null,

  init() {
    this.cacheElements();
    this.bindEvents();
    this.checkInputAndToggleSendButton();
    // 新消息浮标预先挂载（隐藏状态），避免首次需要时才开始创建导致闪一下
    this.ensureNewMessagesBadge();
  },

  cacheElements() {
    this.elements = {
      messageList: document.getElementById('messageList'),
      messageForm: document.getElementById('messageForm'),
      messageText: document.getElementById('messageText'),
      sendButton: document.getElementById('sendButton'),
      functionButton: document.getElementById('functionButton'),
      fileInput: document.getElementById('fileInput'),
      imageInput: document.getElementById('imageInput'),
      cameraInput: document.getElementById('cameraInput'),
      uploadStatus: document.getElementById('uploadStatus'),
      progressBar: document.getElementById('progressBar'),
      fileButton: document.getElementById('fileButton'),
      connectionBar: document.getElementById('connectionBar'),
      navStatusDot: document.getElementById('navStatusDot'),
      aiModeBar: document.getElementById('aiModeBar')
    };
  },

  bindEvents() {
    const ta = this.elements.messageText;
    if (!ta) return;

    ta.addEventListener('input', () => {
      this.autoResizeTextarea();
      this.checkInputAndToggleSendButton();
    });
    ta.addEventListener('paste', () => {
      setTimeout(() => this.checkInputAndToggleSendButton(), 10);
    });
    ta.addEventListener('cut', () => {
      setTimeout(() => this.checkInputAndToggleSendButton(), 10);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        MessageHandler.sendMessage();
      }
    });
  },

  autoResizeTextarea() {
    const ta = this.elements.messageText;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  },

  getInputValue() {
    return this.elements.messageText?.value?.trim() || '';
  },

  clearInput() {
    if (this.elements.messageText) {
      this.elements.messageText.value = '';
      this.autoResizeTextarea();
      this.checkInputAndToggleSendButton();
    }
  },

  focusInput() {
    this.elements.messageText?.focus();
  },

  checkInputAndToggleSendButton() {
    const hasText = !!this.getInputValue();
    const send = this.elements.sendButton;
    const plus = this.elements.functionButton;
    if (send) send.classList.toggle('show', hasText);
    if (plus) plus.classList.toggle('hidden-btn', hasText);
  },

  /**
   * 连接状态指示（智能版）
   *
   * 旧实现在任何非连接态都显示「正在连接...」，包括浏览器明确离线的时候，
   * 用户会以为服务在转圈，其实是自己断网了。这里区分三种语义：
   *
   *   online        在线   —— 导航栏绿点，不显示横幅
   *   reconnecting  重连中 —— 黄点 + 「重连中…」
   *   offline       离线   —— 红点 + 「离线，网络恢复后自动重连」
   *
   * 两个额外改进：
   *   1. 浏览器 navigator.onLine === false 时，无论调用方传什么，一律判为离线；
   *   2. 短暂抖动不闪横幅 —— 状态持续 800ms 才显示，避免刷屏。
   */
  setConnectionStatus(status) {
    const dot = this.elements.navStatusDot;
    const bar = this.elements.connectionBar;

    // 浏览器层面离线时，网络请求必然失败，直接判离线，别再说「连接中」
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    let effective = status;
    if (browserOffline && status !== 'connected' && status !== 'online') {
      effective = 'offline';
    }

    const isOnline = effective === 'connected' || effective === 'online';
    const isReconnecting = effective === 'reconnecting';
    const isConnecting = effective === 'connecting';

    if (dot) {
      dot.className = 'nav-status-dot';
      if (isOnline) dot.classList.add('online');
      else if (isReconnecting || isConnecting) dot.classList.add('connecting');
      else dot.classList.add('offline');

      dot.title = isOnline
        ? '在线'
        : (isConnecting ? '连接中' : (isReconnecting ? '重连中' : '离线'));
    }

    if (!bar) return;

    if (isOnline) {
      clearTimeout(this._connBarTimer);
      bar.classList.remove('show', 'offline', 'connecting', 'reconnecting');
      bar.textContent = '';
      return;
    }

    const text = isConnecting
      ? '连接中…'
      : (isReconnecting ? '重连中…' : '离线，网络恢复后自动重连');

    const apply = () => {
      bar.className = `connection-bar show ${isReconnecting ? 'reconnecting' : (isConnecting ? 'connecting' : 'offline')}`;
      bar.textContent = text;
    };

    // 已经显示着就立即更新文案；否则延迟 800ms 再显示，避免抖动闪烁
    if (bar.classList.contains('show')) {
      apply();
      return;
    }
    clearTimeout(this._connBarTimer);
    this._connBarTimer = setTimeout(apply, 800);
  },

  /* —— 新消息浮标：用户上翻历史时不再被强行拽回底部 —— */
  ensureNewMessagesBadge() {
    let badge = document.getElementById('newMessagesBadge');
    if (badge) return badge;

    badge = document.createElement('button');
    badge.type = 'button';
    badge.id = 'newMessagesBadge';
    badge.className = 'new-messages-badge';
    badge.hidden = true;
    badge.innerHTML = `<span class="new-messages-count">0</span><span>条新消息</span>`;
    badge.addEventListener('click', () => {
      this.hideNewMessagesBadge();
      this.scrollToBottom(true);
    });

    // 挂到 .app-main（position: relative），保证浮标相对聊天区域定位
    const host = document.querySelector('.app-main')
      || document.querySelector('.chat-container')
      || document.body;
    host.appendChild(badge);
    return badge;
  },

  showNewMessagesBadge(count) {
    const badge = this.ensureNewMessagesBadge();
    badge.querySelector('.new-messages-count').textContent = String(count);
    badge.hidden = false;
    requestAnimationFrame(() => badge.classList.add('show'));
  },

  hideNewMessagesBadge() {
    const badge = document.getElementById('newMessagesBadge');
    if (!badge) return;
    badge.classList.remove('show');
    badge.hidden = true;
    this._newMessageCount = 0;
  },

  /** 从 DOM 与缓存中移除一条消息（仅前端表现，服务端已由 API 删除） */
  removeMessage(id) {
    const list = this.elements.messageList;
    if (!list) return false;
    const el = list.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
    if (!el) return false;
    el.classList.add('removing');
    setTimeout(() => el.remove(), 180);
    this.messageCache.delete(String(id));
    return true;
  },

  setConnectionStatus_(status) {
    return this.setConnectionStatus(status);
  },

  showUploadStatus(show, text = '正在上传...', percent = 0, speedText = '') {
    const el = this.elements.uploadStatus;
    const bar = this.elements.progressBar;
    const label = document.getElementById('uploadStatusText');
    const speedEl = document.getElementById('uploadSpeedText');
    if (!el) return;
    el.classList.toggle('show', !!show);
    if (label) label.textContent = text;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (speedEl) {
      speedEl.textContent = show && speedText ? speedText : '';
      speedEl.hidden = !(show && speedText);
    }
  },

  updateAIMode(active) {
    this.elements.aiModeBar?.classList.toggle('active', !!active);
    const ta = this.elements.messageText;
    if (ta) ta.placeholder = active ? '向 AI 提问...' : '发送消息...';
  },

  isNearBottom(threshold = 120) {
    const list = this.elements.messageList;
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight < threshold;
  },

  scrollToBottom(force = false) {
    const list = this.elements.messageList;
    if (!list) return;
    if (force || this.isNearBottom()) {
      requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight;
      });
    }
  },

  ensureTopLoadingIndicator(show) {
    const list = this.elements.messageList;
    if (!list) return;
    let el = list.querySelector('.top-loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'top-loading';
        el.innerHTML = `<div class="spinner"></div><span>加载历史消息...</span>`;
        list.insertBefore(el, list.firstChild);
      }
    } else {
      el?.remove();
    }
  },

  clearMessages() {
    if (this.elements.messageList) this.elements.messageList.innerHTML = '';
    this.messageCache.clear();
    this.lastDateLabel = null;
  },

  renderMessages(messages, { prepend = false, currentDeviceId } = {}) {
    const list = this.elements.messageList;
    if (!list) return;
    const deviceId = currentDeviceId || Utils.getDeviceId();
    const frag = document.createDocumentFragment();
    const pendingImages = [];

    let prevDate = prepend ? null : this.lastDateLabel;
    // prepend 时 messages 应已是正序（旧→新）
    const items = messages.slice();

    for (const msg of items) {
      if (msg == null || msg.id == null) continue;
      if (this.messageCache.has(String(msg.id))) continue;

      const dateLabel = Utils.formatDateSeparator(msg.timestamp);
      if (dateLabel && dateLabel !== prevDate) {
        frag.appendChild(MessageRenderer.createDateSeparator(msg.timestamp));
        prevDate = dateLabel;
      }

      const el = MessageRenderer.createMessageElement(msg, deviceId);
      frag.appendChild(el);
      this.messageCache.set(String(msg.id), msg);

      if (msg._needsImageLoad) pendingImages.push(msg._needsImageLoad);
    }

    if (!prepend) this.lastDateLabel = prevDate;

    if (prepend) {
      const prevHeight = list.scrollHeight;
      const prevTop = list.scrollTop;
      // 插到 top-loading 之后
      const loading = list.querySelector('.top-loading');
      if (loading && loading.nextSibling) {
        list.insertBefore(frag, loading.nextSibling);
      } else if (loading) {
        list.appendChild(frag);
      } else {
        list.insertBefore(frag, list.firstChild);
      }
      list.scrollTop = list.scrollHeight - prevHeight + prevTop;
    } else {
      const stick = this.isNearBottom();
      list.appendChild(frag);
      if (stick) this.scrollToBottom(true);
    }

    pendingImages.forEach(({ r2Key, safeId }) => {
      ImageLoader.load(r2Key, safeId);
    });
  },

  appendMessage(message, currentDeviceId) {
    this.renderMessages([message], { prepend: false, currentDeviceId });
  },

  /** 乐观发送气泡 */
  appendOptimisticMessage({ clientId, content, deviceId, status = 'sending' }) {
    const msg = {
      id: clientId,
      type: 'text',
      content,
      device_id: deviceId || Utils.getDeviceId(),
      timestamp: new Date().toISOString(),
      status,
      _optimistic: true
    };
    const el = MessageRenderer.createMessageElement(msg, Utils.getDeviceId());
    el.classList.add('pending');
    el.dataset.clientId = clientId;
    // 状态图标
    const meta = el.querySelector('.message-meta');
    if (meta) {
      const icon = document.createElement('span');
      icon.className = `message-status-icon ${status}`;
      icon.title = status === 'failed' ? '发送失败，点击重试' : '发送中';
      meta.prepend(icon);
    }
    this.elements.messageList?.appendChild(el);
    this.scrollToBottom(true);
    return el;
  },

  updateMessagesIncremental(messages, currentDeviceId) {
    const list = this.elements.messageList;
    if (!list) return;
    if (this.messageCache.size === 0) {
      this.renderMessages(messages, { currentDeviceId });
      this.scrollToBottom(true);
      return;
    }
    const fresh = (messages || []).filter((m) => m && !this.messageCache.has(String(m.id)));
    if (fresh.length) {
      this.renderMessages(fresh, { currentDeviceId });
    }
  },

  locateMessage(messageId) {
    const list = this.elements.messageList;
    if (!list) return false;
    const el = list.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('locate-flash');
    setTimeout(() => el.classList.remove('locate-flash'), 1200);
    return true;
  },

  showSuccess(msg) { Utils.showToast(msg, 'success'); },
  showError(msg) { Utils.showToast(msg, 'error'); },
  showInfo(msg) { Utils.showToast(msg, 'info'); },

  // 兼容
  showKeyboardHint() { /* no-op: 避免挡输入 */ }
};

if (typeof window !== 'undefined') window.UI = UI;
