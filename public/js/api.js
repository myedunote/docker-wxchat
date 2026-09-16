/**
 * API 封装 v2
 */
const API = {
  _imageBlobCache: new Map(),

  async request(url, options = {}) {
    const { timeout = 15000, raw = false, ...fetchOptions } = options;
    const headers = Auth ? Auth.addAuthHeader({ ...(fetchOptions.headers || {}) }) : { ...(fetchOptions.headers || {}) };

    // JSON 默认头
    if (fetchOptions.body && !(fetchOptions.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    // 超时语义：timeout <= 0 表示「不设超时」，与下方 uploadFile 里
    // `xhr.timeout = 0` 的约定保持一致。
    //
    // ⚠ 不能用 setTimeout(fn, 0) 来表达「不超时」——那等于「下一个 tick 就中止」。
    // 请求几乎必然在拿到响应之前被 abort，报出来的是「请求超时」，
    // 而真正的原因恰恰是「根本没打算设超时」，方向完全反了。
    // 文件下载就踩过这个坑：downloadFile 传 timeout: 0 表示大文件不设硬超时，
    // 结果每次下载都在 0ms 后被自己中止。
    const controller = new AbortController();
    const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal
      });
      if (timeoutId !== null) clearTimeout(timeoutId);

      if (response.status === 401) {
        Auth?.handleUnauthorized?.();
        const err = new Error(CONFIG.ERRORS.UNAUTHORIZED);
        err.status = 401;
        throw err;
      }

      if (raw) return response;

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          message = errBody.error || errBody.message || message;
        } catch { /* ignore */ }
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }
      return response;
    } catch (error) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`请求超时: ${url}`);
      }
      throw error;
    }
  },

  get(url, params = {}, options = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.append(k, v);
    });
    const full = qs.toString() ? `${url}?${qs}` : url;
    return this.request(full, { method: 'GET', ...options });
  },

  post(url, data = {}, options = {}) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(data),
      ...options
    });
  },

  // —— 业务 API ——
  getMessages(params = {}) {
    // 单次加载条数由服务端 MESSAGE_LOAD_DEFAULT 决定（Docker 版默认 5000）
    const defaultLimit = (window.ServerConfig?.messageLimit?.()) || CONFIG.UI.MESSAGE_LOAD_LIMIT;
    return this.get(CONFIG.API.ENDPOINTS.MESSAGES, {
      limit: params.limit ?? defaultLimit,
      offset: params.offset ?? 0,
      beforeId: params.beforeId,
      afterId: params.afterId
    });
  },

  sendMessage(content, deviceId) {
    return this.post(CONFIG.API.ENDPOINTS.MESSAGES, { content, deviceId, type: 'text' });
  },

  /** 删除单条消息（Docker 版新增） */
  deleteMessage(id) {
    return this.request(`${CONFIG.API.ENDPOINTS.MESSAGES}/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },

  /** 读取服务端运行时可配置项 */
  getServerConfig() {
    return this.get(CONFIG.API.ENDPOINTS.CONFIG);
  },

  sendAIMessage(content, deviceId, type = 'ai_response') {
    return this.post(CONFIG.API.ENDPOINTS.AI_MESSAGE, { content, deviceId, type });
  },

  syncDevice(deviceId, deviceName) {
    return this.post(CONFIG.API.ENDPOINTS.SYNC, { deviceId, deviceName });
  },

  async clearAllData(confirmCode) {
    try {
      return await this.post(CONFIG.API.ENDPOINTS.CLEAR_ALL, { confirmCode });
    } catch (e) {
      if (e.status === 404) {
        return this.post(CONFIG.API.ENDPOINTS.CLEAR_ALL_LEGACY, { confirmCode });
      }
      throw e;
    }
  },

  /**
   * 上传文件（带进度 + 实时速度）
   * @param {(info: {percent:number, loaded:number, total:number, speed:number, speedText:string}) => void} onProgress
   */
  uploadFile(file, deviceId, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('deviceId', deviceId);

      xhr.open('POST', CONFIG.API.ENDPOINTS.FILES_UPLOAD);
      const token = Auth?.getToken?.();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      const startedAt = Date.now();
      let lastLoaded = 0;
      let lastAt = startedAt;

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || typeof onProgress !== 'function') return;
        const now = Date.now();
        const dt = (now - lastAt) / 1000;
        // 速度用「本次间隔内新增字节 / 间隔」计算，比累计平均更能反映实时速度
        const speed = dt > 0 ? Math.max(0, (e.loaded - lastLoaded) / dt) : 0;
        lastLoaded = e.loaded;
        lastAt = now;

        onProgress({
          percent: Math.round((e.loaded / e.total) * 100),
          loaded: e.loaded,
          total: e.total,
          speed,
          speedText: Utils.formatSpeed(speed),
          elapsed: (now - startedAt) / 1000
        });
      };

      xhr.onload = () => {
        if (xhr.status === 401) {
          Auth?.handleUnauthorized?.();
          reject(new Error(CONFIG.ERRORS.UNAUTHORIZED));
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300 && data.success) resolve(data);
          else reject(new Error(data.error || data.message || CONFIG.ERRORS.FILE_UPLOAD_FAILED));
        } catch {
          reject(new Error(CONFIG.ERRORS.FILE_UPLOAD_FAILED));
        }
      };
      xhr.onerror = () => reject(new Error(CONFIG.ERRORS.NETWORK));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.timeout = 0; // 大文件不设硬超时，交给网络层
      xhr.send(formData);
    });
  },

  /** 下载接口路径（不含 token），供带鉴权头的 fetch 使用 */
  getDownloadPath(r2Key) {
    return `${CONFIG.API.ENDPOINTS.FILES_DOWNLOAD}/${encodeURIComponent(r2Key).replace(/%2F/g, '/')}`;
  },

  /**
   * 文件下载直链（带 token）
   *
   * 为什么要带 `?token=`：浏览器原生下载是**顶层导航**，不是 fetch，
   * 没法挂 `Authorization` 头。服务端 `authMiddleware` 已支持 query token
   * （`src/worker/auth.js`：`token = c.req.query('token')`），
   * 前端 `realtime.js` 的 EventSource 也一直在用这条路子。
   */
  getDownloadUrl(r2Key) {
    const base = this.getDownloadPath(r2Key);
    const token = Auth?.getToken?.();
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  },

  /**
   * 交给浏览器原生下载器（直链）。
   *
   * 刻意**不 await 任何东西**：整条链路必须留在用户点击的那个 tick 里，
   * 一旦中途 await，用户手势就过期了，下载又会被当成自动下载拦掉。
   *
   * 不加 `target="_blank"`：响应带 `Content-Disposition: attachment`，
   * 浏览器会就地下载而不是导航；加了反而容易吃弹窗拦截。
   */
  downloadByDirectLink(r2Key, fileName) {
    // ⚠ 顺序很重要：必须在**发起导航之前**判过期。
    //   直链是顶层导航、不走 fetch，拿不到 401 分支 ——
    //   token 失效时浏览器会把整个应用页面换成服务端返回的 JSON，
    //   用户既没拿到文件，还丢了当前界面。走 handleUnauthorized 才是正解。
    if (Auth?.isTokenExpired?.()) {
      Auth?.handleUnauthorized?.();
      throw new Error('登录已过期，请重新登录后再下载');
    }
    if (!Auth?.getToken?.()) {
      Auth?.handleUnauthorized?.();
      throw new Error(CONFIG.ERRORS.UNAUTHORIZED);
    }
    const a = document.createElement('a');
    a.href = this.getDownloadUrl(r2Key);
    a.download = fileName || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  /**
   * 下载文件
   *
   * 桌面端：流式读取 + 实时进度/速度 + Blob + `<a download>`。
   * 移动端：直链交给浏览器原生下载器，不统计进度（详见 Utils.useNativeDownload）。
   *
   * ⚠ 平台分支必须收口在**这里**，不能放到调用方 ——
   *   调用方有 3 处（文件卡片下载按钮、长按菜单「下载」、FileUpload 的兜底路径），
   *   只改一处必然漏掉另外两处，症状就是「这个入口好了那个入口还是不行」。
   *
   * @returns {Promise<'stream'|'direct'>} 实际采用的下载方式
   */
  async downloadFile(r2Key, fileName, onProgress) {
    if (!r2Key) throw new Error('缺少文件标识');

    if (Utils.useNativeDownload()) {
      try {
        this.downloadByDirectLink(r2Key, fileName);
        return 'direct';
      } catch (e) {
        Utils.showToast(e.message || '下载失败', 'error');
        throw e;
      }
    }

    try {
      const url = this.getDownloadPath(r2Key);
      const res = await this.request(url, { method: 'GET', raw: true, timeout: 0 });

      const total = Number(res.headers.get('content-length')) || 0;
      const startedAt = Date.now();
      let loaded = 0;
      let lastLoaded = 0;
      let lastAt = startedAt;
      const chunks = [];

      if (res.body && typeof res.body.getReader === 'function' && typeof onProgress === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;

          const now = Date.now();
          const dt = (now - lastAt) / 1000;
          const speed = dt > 0 ? Math.max(0, (loaded - lastLoaded) / dt) : 0;
          lastLoaded = loaded;
          lastAt = now;

          onProgress({
            percent: total ? Math.round((loaded / total) * 100) : 0,
            loaded,
            total,
            speed,
            speedText: Utils.formatSpeed(speed),
            elapsed: (now - startedAt) / 1000
          });
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
      }

      const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);

      // 走到这里一定在桌面端：iOS 已被上面的直链分支拦下。
      // 曾经这里是 `if (Utils.isIOS()) window.open(blobUrl)` ——
      // 在 iPhone 上必然吃弹窗拦截（window.open 非用户手势触发），
      // 回落成 `<a target="_blank">` 又被 iOS Safari 无视，同样是静默失败。
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 8000);
      return 'stream';
    } catch (e) {
      Utils.showToast(e.message || '下载失败', 'error');
      throw e;
    }
  },

  async getImageBlobUrl(r2Key) {
    if (!r2Key) return null;
    if (this._imageBlobCache.has(r2Key)) {
      return this._imageBlobCache.get(r2Key);
    }
    const url = `${CONFIG.API.ENDPOINTS.FILES_DOWNLOAD}/${encodeURIComponent(r2Key).replace(/%2F/g, '/')}`;
    const res = await this.request(url, { method: 'GET', raw: true, timeout: 60000 });
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    this._imageBlobCache.set(r2Key, objectUrl);
    return objectUrl;
  },

  revokeImageBlobUrl(r2Key) {
    const url = this._imageBlobCache.get(r2Key);
    if (url) {
      URL.revokeObjectURL(url);
      this._imageBlobCache.delete(r2Key);
    }
  },

  clearImageBlobCache() {
    for (const url of this._imageBlobCache.values()) {
      URL.revokeObjectURL(url);
    }
    this._imageBlobCache.clear();
  },

  search(params = {}) {
    return this.get(CONFIG.API.ENDPOINTS.SEARCH, params);
  },

  searchSuggestions(q) {
    return this.get(CONFIG.API.ENDPOINTS.SEARCH_SUGGESTIONS, { q });
  },

  getAIConfig() {
    return this.get(CONFIG.API.ENDPOINTS.AI_CONFIG);
  },

  async streamAIChat(payload, { onChunk, signal } = {}) {
    const token = Auth?.getToken?.();
    const res = await fetch(CONFIG.API.ENDPOINTS.AI_CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload),
      signal
    });
    if (res.status === 401) {
      Auth?.handleUnauthorized?.();
      throw new Error(CONFIG.ERRORS.UNAUTHORIZED);
    }
    if (!res.ok) {
      let msg = CONFIG.ERRORS.AI_REQUEST_FAILED;
      try {
        const data = await res.json();
        msg = data.error || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res;
  },

  generateImage(body) {
    return this.post(CONFIG.API.ENDPOINTS.AI_IMAGE, body, { timeout: 120000 });
  },

  saveGeneratedImage(body) {
    return this.post(CONFIG.API.ENDPOINTS.AI_IMAGE_SAVE, body, { timeout: 120000 });
  }
};

if (typeof window !== 'undefined') window.API = API;
