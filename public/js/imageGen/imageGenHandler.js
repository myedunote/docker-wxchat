/**
 * 生图流程：生成 → 保存到 R2 → 刷新消息
 */
const ImageGenHandler = {
  isGenerating: false,

  init() {
    return true;
  },

  async generate(options = {}) {
    if (this.isGenerating) {
      UI.showInfo('正在生成中，请稍候');
      return;
    }
    const prompt = (options.prompt || '').trim();
    if (!prompt) {
      UI.showError(CONFIG.ERRORS.IMAGE_GEN_PROMPT_EMPTY);
      return;
    }
    if (prompt.length > CONFIG.IMAGE_GEN.MAX_PROMPT_LENGTH) {
      UI.showError(CONFIG.ERRORS.IMAGE_GEN_PROMPT_TOO_LONG);
      return;
    }

    this.isGenerating = true;
    UI.showInfo(CONFIG.IMAGE_GEN.GENERATING_INDICATOR);

    try {
      const data = await ImageGenAPI.generate(options);
      const images = data.images || data.data || [];
      const first = images[0] || {};
      const imageUrl = first.url || first.image || first.image_url;
      if (!imageUrl) throw new Error('未返回图片地址');

      await ImageGenAPI.saveToChat(imageUrl, Utils.getDeviceId(), prompt);
      UI.showSuccess(CONFIG.SUCCESS.IMAGE_GEN_SUCCESS);
      await MessageHandler.loadMessages(true);
    } catch (e) {
      console.error('[ImageGenHandler]', e);
      UI.showError(e.message || CONFIG.ERRORS.IMAGE_GEN_FAILED);
    } finally {
      this.isGenerating = false;
    }
  }
};

if (typeof window !== 'undefined') window.ImageGenHandler = ImageGenHandler;
