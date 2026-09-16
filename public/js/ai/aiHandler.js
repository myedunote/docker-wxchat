/**
 * AI 消息处理 v2
 */
const AIHandler = {
  isAIMode: false,
  isProcessing: false,
  serverEnabled: true,

  init() {
    this.bindEvents();
    AIAPI.getConfig().then((cfg) => {
      this.serverEnabled = cfg.aiEnabled !== false;
    }).catch(() => {});
    return true;
  },

  bindEvents() {
    document.addEventListener('beforeMessageSend', (event) => {
      const { content } = event.detail || {};
      if (this.isAIMessage(content)) {
        event.preventDefault();
        this.handleAIMessage(content);
      }
    });
  },

  isAIMessage(content) {
    if (!content) return false;
    if (this.isAIMode) return true;
    const c = content.trim().toLowerCase();
    return c.startsWith('🤖') || c.startsWith('ai:') || c.startsWith('ai ');
  },

  toggleAIMode() {
    this.isAIMode = !this.isAIMode;
    UI.updateAIMode(this.isAIMode);
    UI.showSuccess(this.isAIMode ? CONFIG.SUCCESS.AI_MODE_ENABLED : CONFIG.SUCCESS.AI_MODE_DISABLED);
    document.dispatchEvent(new CustomEvent('aiModeChanged', {
      detail: { isAIMode: this.isAIMode }
    }));
    return this.isAIMode;
  },

  cleanAIMessage(content) {
    return String(content || '')
      .replace(/^🤖\s*/, '')
      .replace(/^ai:\s*/i, '')
      .replace(/^ai\s+/i, '')
      .trim();
  },

  async handleAIMessage(content) {
    if (this.isProcessing) {
      UI.showInfo('AI 正在处理上一轮对话');
      return;
    }
    if (!this.serverEnabled) {
      UI.showError('AI 功能未启用或未配置密钥');
      return;
    }

    this.isProcessing = true;
    const clean = this.cleanAIMessage(content);
    if (!clean) {
      this.isProcessing = false;
      return;
    }

    try {
      await API.sendMessage(clean, Utils.getDeviceId());
      await MessageHandler.loadMessages(true);

      const streamingEl = AIUI.createStreamingBubble();
      let full = '';
      let thinking = '';

      const result = await AIAPI.streamChat(clean, {
        onResponse: (_chunk, fullResponse) => {
          full = fullResponse;
          AIUI.updateStreaming(streamingEl, full, thinking);
        },
        onThinking: (_chunk, fullThinking) => {
          thinking = fullThinking;
          AIUI.updateStreaming(streamingEl, full, thinking);
        }
      });

      AIUI.completeStreaming(streamingEl);
      await new Promise((r) => setTimeout(r, 300));
      streamingEl?.remove();

      const answer = result.response || full || '抱歉，我无法生成回答。';
      await API.sendAIMessage(answer, 'ai-system', 'ai_response');
      await MessageHandler.loadMessages(true);
    } catch (e) {
      if (e.name === 'AbortError') {
        UI.showInfo('已取消 AI 请求');
      } else {
        console.error('[AIHandler]', e);
        UI.showError(e.message || CONFIG.ERRORS.AI_REQUEST_FAILED);
      }
    } finally {
      this.isProcessing = false;
    }
  }
};

if (typeof window !== 'undefined') window.AIHandler = AIHandler;
