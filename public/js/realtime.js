/**
 * 实时通信 v2 — SSE + 长轮询降级
 * 只 emit 事件，不直接刷消息（避免双刷新）
 */
class RealtimeManager {
  constructor() {
    this.eventSource = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.deviceId = null;
    this.lastMessageId = 0;
    this.listeners = new Map();
    this.longPollingActive = false;
    this._destroyed = false;
    this._pollTimer = null;
  }

  init(deviceId, lastMessageId = 0) {
    this.deviceId = deviceId;
    this.lastMessageId = lastMessageId || 0;
    this._destroyed = false;
    this.connect();
    this.bindNetworkEvents();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, data) {
    this.listeners.get(event)?.forEach((fn) => {
      try { fn(data); } catch (e) { console.error('[Realtime] listener error', e); }
    });
  }

  setLastMessageId(id) {
    const n = parseInt(id, 10) || 0;
    if (n > this.lastMessageId) this.lastMessageId = n;
  }

  connect() {
    if (this._destroyed) return;
    if (typeof EventSource === 'undefined') {
      this.fallbackToLongPolling();
      return;
    }

    this.disconnect(false);
    // 浏览器明确离线时不要谎报「连接中」，直接显示离线
    UI.setConnectionStatus(this.isBrowserOffline() ? 'offline' : 'connecting');

    try {
      const token = Auth?.getToken?.() || '';
      const url = `${CONFIG.API.ENDPOINTS.EVENTS}?deviceId=${encodeURIComponent(this.deviceId)}&token=${encodeURIComponent(token)}&lastMessageId=${this.lastMessageId}`;
      this.eventSource = new EventSource(url);

      this.eventSource.addEventListener('connection', () => {
        if (this._destroyed) return;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.longPollingActive = false;
        UI.setConnectionStatus('connected');
        this.emit('connected');
      });

      this.eventSource.addEventListener('message', (event) => {
        if (this._destroyed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.lastMessageId) this.setLastMessageId(data.lastMessageId);
          if (data.newMessages > 0 || (data.messages && data.messages.length)) {
            this.emit('newMessages', data);
          }
        } catch { /* ignore */ }
      });

      this.eventSource.addEventListener('heartbeat', () => {
        this.emit('heartbeat');
      });

      this.eventSource.addEventListener('timeout', (event) => {
        if (this._destroyed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.lastMessageId) this.setLastMessageId(data.lastMessageId);
        } catch { /* ignore */ }
        this.disconnect(false);
        this.connect();
      });

      this.eventSource.onerror = () => {
        if (this._destroyed) return;
        this.isConnected = false;
        UI.setConnectionStatus(this.isBrowserOffline() ? 'offline' : 'reconnecting');
        this.emit('disconnected');
        this.handleReconnect();
      };
    } catch (e) {
      console.error('[Realtime] connect failed', e);
      this.fallbackToLongPolling();
    }
  }

  handleReconnect() {
    if (this._destroyed) return;
    this.disconnect(false);
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.fallbackToLongPolling();
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * (2 ** (this.reconnectAttempts - 1)), 10000);
    UI.setConnectionStatus(this.isBrowserOffline() ? 'offline' : 'reconnecting');
    setTimeout(() => this.connect(), delay);
  }

  /** 浏览器层面的离线判定：offline 事件比任何 HTTP 报错都更权威 */
  isBrowserOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  fallbackToLongPolling() {
    if (this._destroyed || this.longPollingActive) return;
    this.longPollingActive = true;
    this.isConnected = false;
    // 走到这里说明 SSE 已经连不上了，语义上是「重连中」而不是首次「连接中」
    UI.setConnectionStatus(this.isBrowserOffline() ? 'offline' : 'reconnecting');
    this.emit('disconnected');
    this.pollLoop();
  }

  async pollLoop() {
    if (this._destroyed || !this.longPollingActive) return;
    try {
      const token = Auth?.getToken?.() || '';
      const params = new URLSearchParams({
        deviceId: this.deviceId,
        lastMessageId: String(this.lastMessageId),
        timeout: '25',
        token
      });
      const res = await fetch(`${CONFIG.API.ENDPOINTS.POLL}?${params}`, {
        headers: Auth.addAuthHeader({})
      });
      if (res.status === 401) {
        Auth.handleUnauthorized();
        return;
      }
      const data = await res.json();
      if (data.success) {
        UI.setConnectionStatus('connected');
        if (data.hasNewMessages) {
          if (data.lastMessageId) this.setLastMessageId(data.lastMessageId);
          this.emit('newMessages', data);
        }
      }
    } catch (e) {
      // 长轮询是降级通道，失败只更新状态，不弹错误打扰用户
      UI.setConnectionStatus(this.isBrowserOffline() ? 'offline' : 'reconnecting');
    }
    if (this._destroyed || !this.longPollingActive) return;
    // 降级轮询间隔 5s（旧版 1s 过密；SSE 才是主通道，轮询只在 SSE 不可用时兜底）
    this._pollTimer = setTimeout(() => this.pollLoop(), CONFIG.UI.POLL_RETRY_INTERVAL || 5000);
  }

  bindNetworkEvents() {
    window.addEventListener('online', () => {
      if (!this.isConnectionAlive()) {
        this.reconnectAttempts = 0;
        this.longPollingActive = false;
        this.connect();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.isConnectionAlive()) {
        this.reconnectAttempts = 0;
        this.longPollingActive = false;
        this.connect();
      }
    });
  }

  isConnectionAlive() {
    if (this.eventSource &&
      (this.eventSource.readyState === EventSource.OPEN || this.eventSource.readyState === EventSource.CONNECTING)) {
      return true;
    }
    return this.longPollingActive;
  }

  disconnect(destroy = true) {
    if (this.eventSource) {
      try { this.eventSource.close(); } catch { /* ignore */ }
      this.eventSource = null;
    }
    clearTimeout(this._pollTimer);
    this.isConnected = false;
    if (destroy) {
      this.longPollingActive = false;
      this._destroyed = true;
    }
  }
}

const Realtime = new RealtimeManager();
if (typeof window !== 'undefined') window.Realtime = Realtime;
