/**
 * 服务端运行时配置加载器
 *
 * 自托管场景下很多参数应该由运维通过环境变量控制，而不是写死在前端：
 *   最大上传体积 / 单次加载条数 / 清空是否需要确认码 / AI 是否可用
 *
 * 启动时拉一次 GET /api/config，写入 CONFIG.RUNTIME（唯一可写的配置层）。
 * 拉取失败不影响使用 —— 全部回落到 config.js 里的静态默认值。
 */
const ServerConfig = {
  _data: null,
  _promise: null,

  /** 拉取并应用服务端配置（幂等，多次调用只会请求一次） */
  load(force = false) {
    if (this._promise && !force) return this._promise;

    this._promise = (async () => {
      try {
        const res = await API.getServerConfig();
        const data = res?.data || res || {};
        this._data = data;

        CONFIG.RUNTIME.loaded = true;
        CONFIG.RUNTIME.messageLoadDefault = this._num(data.messageLoadDefault);
        CONFIG.RUNTIME.messageLoadMax = this._num(data.messageLoadMax);
        CONFIG.RUNTIME.maxFileSize = this._num(data.maxFileSize);
        CONFIG.RUNTIME.maxFileSizeText = data.maxFileSizeText || null;
        CONFIG.RUNTIME.clearConfirmRequired = data.clearConfirmRequired === true;
        CONFIG.RUNTIME.aiEnabled = data.aiEnabled === true;
        CONFIG.RUNTIME.imageGenEnabled = data.imageGenEnabled === true;
        CONFIG.RUNTIME.timezone = data.timezone || null;

        // 同步到需要即时生效的静态项
        if (CONFIG.RUNTIME.maxFileSize !== null) {
          CONFIG.FILE.MAX_SIZE = CONFIG.RUNTIME.maxFileSize;
        }
        if (CONFIG.RUNTIME.clearConfirmRequired !== null) {
          CONFIG.CLEAR.CONFIRM_REQUIRED = CONFIG.RUNTIME.clearConfirmRequired;
        }

        console.log('[ServerConfig] 已应用服务端配置', {
          加载条数: this.messageLimit(),
          最大上传: data.maxFileSizeText,
          清空需确认码: data.clearConfirmRequired,
          AI可用: data.aiEnabled
        });
      } catch (e) {
        console.warn('[ServerConfig] 拉取失败，使用前端默认配置', e?.message || e);
      }
      return this._data;
    })();

    return this._promise;
  },

  _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },

  /** 单次加载条数：优先服务端下发，其次静态默认 */
  messageLimit() {
    return CONFIG.runtime('messageLoadDefault', CONFIG.UI.MESSAGE_LOAD_LIMIT) || CONFIG.UI.MESSAGE_LOAD_LIMIT;
  },

  /** 单次加载硬上限 */
  messageLimitMax() {
    return CONFIG.runtime('messageLoadMax', CONFIG.UI.MESSAGE_LOAD_LIMIT) || CONFIG.UI.MESSAGE_LOAD_LIMIT;
  },

  /** 最大上传字节数；0 表示不限制 */
  maxFileSize() {
    const v = CONFIG.runtime('maxFileSize', CONFIG.FILE.MAX_SIZE);
    return typeof v === 'number' ? v : CONFIG.FILE.MAX_SIZE;
  },

  /** 清空数据是否需要额外输入确认码 */
  clearConfirmRequired() {
    return CONFIG.runtime('clearConfirmRequired', false) === true;
  },

  aiEnabled() {
    return CONFIG.runtime('aiEnabled', CONFIG.AI.ENABLED) === true;
  },

  imageGenEnabled() {
    return CONFIG.runtime('imageGenEnabled', CONFIG.IMAGE_GEN.ENABLED) === true;
  },

  raw() {
    return this._data;
  }
};

if (typeof window !== 'undefined') window.ServerConfig = ServerConfig;
