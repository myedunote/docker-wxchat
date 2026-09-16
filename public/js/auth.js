/**
 * 鉴权模块 v2
 */
const Auth = {
  config: {
    TOKEN_KEY: 'wxchat_auth_token',
    LOGIN_ATTEMPTS_KEY: 'wxchat_login_attempts',
    MAX_ATTEMPTS: 5,
    ATTEMPT_RESET_TIME: 15 * 60 * 1000,
    TOKEN_REFRESH_INTERVAL: 30 * 60 * 1000
  },

  state: {
    isAuthenticated: false,
    token: null,
    refreshTimer: null,
    loginAttempts: 0,
    lastAttemptTime: 0
  },

  init() {
    this.loadStoredData();
  },

  initLoginPage() {
    this.loadStoredData();
    this.bindLoginEvents();
    this.checkLoginAttempts();
    if (this.getToken()) {
      this.checkAuthentication().then((ok) => {
        if (ok) this.redirectToApp();
      });
    }
  },

  loadStoredData() {
    try {
      this.state.token = localStorage.getItem(this.config.TOKEN_KEY);
      const attemptsData = localStorage.getItem(this.config.LOGIN_ATTEMPTS_KEY);
      if (attemptsData) {
        const data = JSON.parse(attemptsData);
        this.state.loginAttempts = data.count || 0;
        this.state.lastAttemptTime = data.lastTime || 0;
      }
    } catch (e) {
      console.error('[Auth] load failed', e);
    }
  },

  getToken() {
    return this.state.token || localStorage.getItem(this.config.TOKEN_KEY);
  },

  setToken(token) {
    this.state.token = token;
    this.state.isAuthenticated = !!token;
    if (token) localStorage.setItem(this.config.TOKEN_KEY, token);
    else localStorage.removeItem(this.config.TOKEN_KEY);
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  /**
   * token 是否已过期（纯本地解析，不发请求）
   *
   * 为什么需要它：`isAuthenticated()` 只看「有没有 token」，不看「还作不作数」。
   * 平时这不是问题 —— 任何一次 API 调用拿到 401 都会触发 handleUnauthorized，
   * 前端就会回登录页。但**移动端直链下载是顶层导航**，不走 fetch，
   * 拿不到那个 401 分支：浏览器会把整个应用页面替换成服务端返回的 JSON
   * （`{"success":false,"error":"Token无效或已过期"}`）。
   * 用户既没拿到文件，还丢了当前界面 —— 比单纯下载失败糟糕得多。
   * 所以这里先在本地判一次，过期就走正常的重新登录流程。
   *
   * ⚠ 服务端签发的 `exp` 是**毫秒**时间戳（见 `src/worker/auth.js` 的
   *   `Date.now() + expireHours * 3600 * 1000`），不是 JWT 标准的秒。
   *   按标准当成秒去比较，会得出「1970 年就过期了」的荒谬结论。
   *
   * 解析失败一律当作「已过期」：宁可让用户重新登录一次，
   * 也不要带着一个解析不出来的 token 去做顶层导航。
   */
  isTokenExpired() {
    const token = this.getToken();
    if (!token) return true;
    try {
      const payload = token.split('.')[1];
      if (!payload) return true;
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
      const data = JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));
      // 没有 exp 字段时不做判断，交给服务端定夺（避免误伤未来的无过期 token）
      if (!data.exp) return false;
      return Date.now() > data.exp;
    } catch {
      return true;
    }
  },

  addAuthHeader(headers = {}) {
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },

  bindLoginEvents() {
    const form = document.getElementById('loginForm');
    const passwordInput = document.getElementById('passwordInput');
    const passwordToggle = document.getElementById('passwordToggle');

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    passwordInput?.addEventListener('input', () => {
      this.hideMessage('errorMessage');
    });

    passwordToggle?.addEventListener('click', () => {
      if (!passwordInput) return;
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      passwordToggle.textContent = show ? '隐藏' : '显示';
      passwordToggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    });
  },

  checkLoginAttempts() {
    const now = Date.now();
    if (this.state.lastAttemptTime && now - this.state.lastAttemptTime > this.config.ATTEMPT_RESET_TIME) {
      this.state.loginAttempts = 0;
      this.persistAttempts();
    }
    if (this.state.loginAttempts >= this.config.MAX_ATTEMPTS) {
      const remain = this.config.ATTEMPT_RESET_TIME - (now - this.state.lastAttemptTime);
      if (remain > 0) {
        const mins = Math.ceil(remain / 60000);
        this.showMessage('warningMessage', `登录失败次数过多，请 ${mins} 分钟后再试`);
        const btn = document.getElementById('loginButton');
        if (btn) btn.disabled = true;
        setTimeout(() => {
          this.state.loginAttempts = 0;
          this.persistAttempts();
          if (btn) btn.disabled = false;
          this.hideMessage('warningMessage');
        }, remain);
      }
    }
  },

  persistAttempts() {
    localStorage.setItem(this.config.LOGIN_ATTEMPTS_KEY, JSON.stringify({
      count: this.state.loginAttempts,
      lastTime: this.state.lastAttemptTime
    }));
  },

  async handleLogin() {
    const passwordInput = document.getElementById('passwordInput');
    const loginButton = document.getElementById('loginButton');
    const password = passwordInput?.value || '';

    if (!password) {
      this.showMessage('errorMessage', '请输入密码');
      return;
    }

    if (this.state.loginAttempts >= this.config.MAX_ATTEMPTS) {
      this.checkLoginAttempts();
      return;
    }

    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = '登录中...';
    }

    try {
      const res = await fetch(CONFIG.API.ENDPOINTS.AUTH_LOGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        this.state.loginAttempts += 1;
        this.state.lastAttemptTime = Date.now();
        this.persistAttempts();
        const msg = data.error || data.message || '密码错误';
        this.showMessage('errorMessage', msg);
        if (this.state.loginAttempts >= this.config.MAX_ATTEMPTS) this.checkLoginAttempts();
        return;
      }

      const token = data.data?.token || data.token;
      if (!token) {
        this.showMessage('errorMessage', '登录响应异常');
        return;
      }

      this.setToken(token);
      this.state.loginAttempts = 0;
      this.persistAttempts();
      this.redirectToApp();
    } catch (e) {
      console.error('[Auth] login error', e);
      this.showMessage('errorMessage', CONFIG.ERRORS.NETWORK);
    } finally {
      if (loginButton) {
        loginButton.disabled = false;
        loginButton.textContent = '登 录';
      }
    }
  },

  async checkAuthentication() {
    const token = this.getToken();
    if (!token) {
      this.state.isAuthenticated = false;
      return false;
    }
    try {
      const res = await fetch(CONFIG.API.ENDPOINTS.AUTH_VERIFY, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.valid) {
        this.state.isAuthenticated = true;
        this.startTokenRefresh();
        return true;
      }
      this.setToken(null);
      this.state.isAuthenticated = false;
      return false;
    } catch {
      // 网络失败时暂信本地 token，避免弱网踢出
      this.state.isAuthenticated = !!token;
      return !!token;
    }
  },

  startTokenRefresh() {
    clearInterval(this.state.refreshTimer);
    this.state.refreshTimer = setInterval(() => {
      this.checkAuthentication().then((ok) => {
        if (!ok && !location.pathname.includes('login')) {
          this.redirectToLogin();
        }
      });
    }, this.config.TOKEN_REFRESH_INTERVAL);
  },

  async logout() {
    try {
      const token = this.getToken();
      if (token) {
        await fetch(CONFIG.API.ENDPOINTS.AUTH_LOGOUT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        }).catch(() => {});
      }
    } finally {
      clearInterval(this.state.refreshTimer);
      this.setToken(null);
      this.redirectToLogin();
    }
  },

  redirectToApp() {
    location.href = '/index.html';
  },

  redirectToLogin() {
    location.href = '/login.html';
  },

  showMessage(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
  },

  hideMessage(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('show');
  },

  handleUnauthorized() {
    this.setToken(null);
    if (!location.pathname.includes('login')) {
      Utils.showToast(CONFIG.ERRORS.UNAUTHORIZED, 'error');
      setTimeout(() => this.redirectToLogin(), 500);
    }
  }
};

if (typeof window !== 'undefined') window.Auth = Auth;
