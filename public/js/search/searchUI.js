/**
 * 搜索全屏面板
 */
const SearchUI = {
  panel: null,
  state: {
    q: '',
    type: 'all',
    timeRange: 'all',
    fileType: 'all',
    offset: 0,
    total: 0,
    loading: false
  },

  init() {
    return true;
  },

  showSearchModal() {
    this.close();
    const history = Utils.storage.get(CONFIG.SEARCH.HISTORY_KEY, []) || [];
    const panel = document.createElement('div');
    panel.className = 'search-panel';
    panel.id = 'searchModal';
    panel.innerHTML = `
      <div class="search-header">
        <div class="search-input-wrap">
          <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input class="search-input" id="searchInput" type="search" placeholder="搜索消息与文件" enterkeyhint="search" />
        </div>
        <button type="button" class="search-cancel" id="searchCancel">取消</button>
      </div>
      <div class="search-filters" id="searchFilters">
        <button type="button" class="filter-chip active" data-filter="type" data-value="all">全部</button>
        <button type="button" class="filter-chip" data-filter="type" data-value="text">文本</button>
        <button type="button" class="filter-chip" data-filter="type" data-value="file">文件</button>
        <button type="button" class="filter-chip" data-filter="timeRange" data-value="today">今天</button>
        <button type="button" class="filter-chip" data-filter="timeRange" data-value="week">7天</button>
        <button type="button" class="filter-chip" data-filter="timeRange" data-value="month">30天</button>
        <button type="button" class="filter-chip" data-filter="fileType" data-value="image">图片</button>
        <button type="button" class="filter-chip" data-filter="fileType" data-value="document">文档</button>
      </div>
      <div class="search-body" id="searchBody">
        <div class="search-history" id="searchHistory">
          <div class="search-section-title">
            <span>搜索历史</span>
            <button type="button" id="clearHistoryBtn">清除</button>
          </div>
          <div id="historyList"></div>
        </div>
        <div class="search-suggestions" id="searchSuggestions" style="display:none"></div>
        <div class="search-results" id="searchResults" style="display:none"></div>
      </div>
    `;
    document.body.appendChild(panel);
    this.panel = panel;
    requestAnimationFrame(() => panel.classList.add('show'));

    this.renderHistory(history);
    this.bindPanelEvents(panel);
    setTimeout(() => panel.querySelector('#searchInput')?.focus(), 200);
  },

  bindPanelEvents(panel) {
    panel.querySelector('#searchCancel')?.addEventListener('click', () => this.close());

    const input = panel.querySelector('#searchInput');
    const debounced = Utils.debounce(() => this.onQueryChange(), CONFIG.SEARCH.DEBOUNCE_DELAY);
    input?.addEventListener('input', debounced);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.runSearch(true);
      }
    });

    panel.querySelector('#searchFilters')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      const filter = chip.dataset.filter;
      const value = chip.dataset.value;
      // 同组互斥
      panel.querySelectorAll(`.filter-chip[data-filter="${filter}"]`).forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      // 全部 type 时重置 fileType 视觉
      if (filter === 'type') this.state.type = value;
      if (filter === 'timeRange') {
        // time 可再次点 all：这里简化为直接设值；无 all chip 时用 week/month/today
        this.state.timeRange = value;
      }
      if (filter === 'fileType') this.state.fileType = value;
      if (this.state.q) this.runSearch(true);
    });

    panel.querySelector('#clearHistoryBtn')?.addEventListener('click', () => {
      Utils.storage.set(CONFIG.SEARCH.HISTORY_KEY, []);
      this.renderHistory([]);
    });

    panel.querySelector('#historyList')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-q]');
      if (!item) return;
      input.value = item.dataset.q;
      this.runSearch(true);
    });

    panel.querySelector('#searchResults')?.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-id]');
      if (!item) return;
      const id = item.dataset.id;
      this.close();
      const ok = await MessageHandler.locateMessage(id);
      if (!ok) UI.showInfo('未在本地列表中找到该消息');
    });
  },

  renderHistory(list) {
    const host = this.panel?.querySelector('#historyList');
    if (!host) return;
    if (!list.length) {
      host.innerHTML = `<div class="search-empty">暂无搜索历史</div>`;
      return;
    }
    host.innerHTML = list.map((q) => `
      <div class="history-item" data-q="${Utils.escapeHtml(q)}">🕐 ${Utils.escapeHtml(q)}</div>
    `).join('');
  },

  pushHistory(q) {
    let list = Utils.storage.get(CONFIG.SEARCH.HISTORY_KEY, []) || [];
    list = [q, ...list.filter((x) => x !== q)].slice(0, CONFIG.SEARCH.HISTORY_LIMIT);
    Utils.storage.set(CONFIG.SEARCH.HISTORY_KEY, list);
  },

  async onQueryChange() {
    const q = this.panel?.querySelector('#searchInput')?.value?.trim() || '';
    this.state.q = q;
    if (!q) {
      this.panel.querySelector('#searchHistory').style.display = '';
      this.panel.querySelector('#searchSuggestions').style.display = 'none';
      this.panel.querySelector('#searchResults').style.display = 'none';
      return;
    }
    // 建议
    const suggestions = await SearchAPI.suggestions(q);
    const host = this.panel.querySelector('#searchSuggestions');
    if (suggestions.length) {
      host.style.display = '';
      host.innerHTML = `
        <div class="search-section-title"><span>搜索建议</span></div>
        ${suggestions.map((s) => `<div class="suggestion-item" data-q="${Utils.escapeHtml(s)}">${Utils.escapeHtml(s)}</div>`).join('')}
      `;
      host.querySelectorAll('[data-q]').forEach((el) => {
        el.addEventListener('click', () => {
          this.panel.querySelector('#searchInput').value = el.dataset.q;
          this.runSearch(true);
        });
      });
    } else {
      host.style.display = 'none';
    }
    this.runSearch(true);
  },

  async runSearch(reset = false) {
    const q = this.panel?.querySelector('#searchInput')?.value?.trim() || '';
    this.state.q = q;
    if (!q) return;
    if (reset) {
      this.state.offset = 0;
      this.state.total = 0;
    }
    if (this.state.loading) return;
    this.state.loading = true;

    const history = this.panel.querySelector('#searchHistory');
    const results = this.panel.querySelector('#searchResults');
    history.style.display = 'none';
    results.style.display = '';
    if (reset) results.innerHTML = `<div class="search-loading">搜索中...</div>`;

    try {
      // 处理 timeRange：未选 today/week/month 时为 all
      let timeRange = 'all';
      const activeTime = this.panel.querySelector('.filter-chip[data-filter="timeRange"].active');
      if (activeTime) timeRange = activeTime.dataset.value;

      let type = 'all';
      const activeType = this.panel.querySelector('.filter-chip[data-filter="type"].active');
      if (activeType) type = activeType.dataset.value;

      let fileType = 'all';
      const activeFile = this.panel.querySelector('.filter-chip[data-filter="fileType"].active');
      if (activeFile) fileType = activeFile.dataset.value;

      const res = await SearchAPI.search({
        q,
        type,
        timeRange,
        fileType,
        limit: CONFIG.SEARCH.RESULTS_PER_PAGE,
        offset: this.state.offset
      });

      this.pushHistory(q);
      const rows = (res.data || []).map((r) => SearchAPI.formatResult(r));
      this.state.total = res.total || 0;

      if (!rows.length && reset) {
        results.innerHTML = `<div class="search-empty">${CONFIG.ERRORS.SEARCH_NO_RESULTS}</div>`;
      } else {
        const html = rows.map((r) => {
          const content = Utils.escapeHtml(r.content).replace(
            new RegExp(Utils.escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'),
            (m) => `<span class="search-highlight">${m}</span>`
          );
          return `
            <div class="search-result-item" data-id="${r.id}">
              <div class="search-result-meta">
                <span>${r.type}</span>
                <span>${Utils.formatTime(r.timestamp)}</span>
              </div>
              <div class="search-result-content">${content}</div>
            </div>
          `;
        }).join('');

        if (reset) results.innerHTML = html;
        else results.insertAdjacentHTML('beforeend', html);

        // 加载更多
        results.querySelector('.search-load-more')?.remove();
        if (this.state.offset + rows.length < this.state.total) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'search-load-more';
          more.textContent = '加载更多';
          more.addEventListener('click', () => {
            this.state.offset += CONFIG.SEARCH.RESULTS_PER_PAGE;
            this.runSearch(false);
          });
          results.appendChild(more);
        }
      }
    } catch (e) {
      results.innerHTML = `<div class="search-empty">${Utils.escapeHtml(e.message || CONFIG.ERRORS.SEARCH_FAILED)}</div>`;
    } finally {
      this.state.loading = false;
    }
  },

  loadMoreResults() {
    this.state.offset += CONFIG.SEARCH.RESULTS_PER_PAGE;
    return this.runSearch(false);
  },

  close() {
    if (!this.panel) return;
    const el = this.panel;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 280);
    this.panel = null;
    this.state = { q: '', type: 'all', timeRange: 'all', fileType: 'all', offset: 0, total: 0, loading: false };
  }
};

if (typeof window !== 'undefined') window.SearchUI = SearchUI;
