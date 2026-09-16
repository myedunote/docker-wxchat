/**
 * 轻量事件总线 — 解耦模块直调
 */
const EventBus = {
  _map: new Map(),

  on(event, handler) {
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(handler);
    return () => this.off(event, handler);
  },

  once(event, handler) {
    const wrap = (payload) => {
      this.off(event, wrap);
      handler(payload);
    };
    return this.on(event, wrap);
  },

  off(event, handler) {
    this._map.get(event)?.delete(handler);
  },

  emit(event, payload) {
    const set = this._map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (e) { console.error(`[EventBus] ${event}`, e); }
    }
  },

  clear() {
    this._map.clear();
  }
};

if (typeof window !== 'undefined') window.EventBus = EventBus;
