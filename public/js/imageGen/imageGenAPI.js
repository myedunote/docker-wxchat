/**
 * 生图 API — 服务端代理
 */
const ImageGenAPI = {
  controller: null,

  async generate(options = {}) {
    this.controller = new AbortController();
    const res = await API.generateImage({
      prompt: options.prompt,
      negative_prompt: options.negativePrompt || options.negative_prompt,
      size: options.size || CONFIG.IMAGE_GEN.DEFAULT_SIZE,
      steps: options.steps || CONFIG.IMAGE_GEN.DEFAULT_STEPS,
      guidance: options.guidance || CONFIG.IMAGE_GEN.DEFAULT_GUIDANCE
    });
    return res.data || res;
  },

  async saveToChat(imageUrl, deviceId, prompt) {
    return API.saveGeneratedImage({ imageUrl, deviceId, prompt });
  },

  abort() {
    this.controller?.abort();
  }
};

if (typeof window !== 'undefined') window.ImageGenAPI = ImageGenAPI;
