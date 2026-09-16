/**
 * AI API — 仅调用自家 Worker 代理，不持有第三方密钥
 */
const AIAPI = {
  controller: null,

  validateConfig() {
    return true;
  },

  async getConfig() {
    try {
      const res = await API.getAIConfig();
      return res.data || res;
    } catch {
      return { aiEnabled: false, imageGenEnabled: false };
    }
  },

  async streamChat(content, { onResponse, onThinking, signal } = {}) {
    this.controller = new AbortController();
    const linked = signal || this.controller.signal;

    const res = await API.streamAIChat(
      { content, messages: [{ role: 'user', content }] },
      { signal: linked }
    );

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let thinking = '';
    let inThink = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta || {};
          let piece = delta.content || '';
          // 兼容 reasoning_content
          if (delta.reasoning_content) {
            thinking += delta.reasoning_content;
            onThinking?.(delta.reasoning_content, thinking);
          }
          if (!piece) continue;

          // 解析 <think> 块
          let rest = piece;
          while (rest) {
            if (!inThink) {
              const start = rest.indexOf('<think>');
              if (start === -1) {
                full += rest;
                onResponse?.(rest, full);
                rest = '';
              } else {
                const before = rest.slice(0, start);
                if (before) {
                  full += before;
                  onResponse?.(before, full);
                }
                inThink = true;
                rest = rest.slice(start + 7);
              }
            } else {
              const end = rest.indexOf('</think>');
              if (end === -1) {
                thinking += rest;
                onThinking?.(rest, thinking);
                rest = '';
              } else {
                thinking += rest.slice(0, end);
                onThinking?.(rest.slice(0, end), thinking);
                inThink = false;
                rest = rest.slice(end + 8);
              }
            }
          }
        } catch { /* ignore partial json */ }
      }
    }

    return { response: full.trim(), thinking: thinking.trim() };
  },

  abort() {
    this.controller?.abort();
    this.controller = null;
  }
};

if (typeof window !== 'undefined') window.AIAPI = AIAPI;
