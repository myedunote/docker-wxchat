/**
 * 搜索 API
 */
const SearchAPI = {
  cache: new Map(),

  async search(params = {}) {
    const key = JSON.stringify(params);
    if (this.cache.has(key)) return this.cache.get(key);
    const res = await API.search(params);
    this.cache.set(key, res);
    // 简单限制缓存大小
    if (this.cache.size > 30) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    return res;
  },

  async suggestions(q) {
    if (!q || q.length < 2) return [];
    try {
      const res = await API.searchSuggestions(q);
      return res.data || [];
    } catch {
      return [];
    }
  },

  clearCache() {
    this.cache.clear();
  },

  formatResult(item) {
    return {
      id: item.id,
      type: item.type,
      content: item.content || item.original_name || '',
      deviceId: item.device_id,
      timestamp: item.timestamp,
      fileName: item.original_name,
      fileSize: item.file_size,
      mimeType: item.mime_type,
      r2Key: item.r2_key
    };
  }
};

if (typeof window !== 'undefined') window.SearchAPI = SearchAPI;
