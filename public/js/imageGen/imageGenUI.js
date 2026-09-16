/**
 * 生图弹窗 UI
 */
const ImageGenUI = {
  overlay: null,

  init() {
    return true;
  },

  show() {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'image-gen-overlay';
    overlay.innerHTML = `
      <div class="image-gen-sheet" role="dialog" aria-label="AI绘画">
        <div class="image-gen-header">
          <h3>AI 绘画</h3>
          <button type="button" class="close-btn" aria-label="关闭">×</button>
        </div>
        <form class="image-gen-form" id="imageGenForm">
          <label for="igPrompt">描述提示词</label>
          <textarea id="igPrompt" maxlength="1000" placeholder="描述你想生成的图片..." required></textarea>
          <label for="igNegative">反向提示词（可选）</label>
          <input id="igNegative" type="text" placeholder="不想出现的元素" />
          <div class="image-gen-row">
            <div>
              <label for="igSize">尺寸</label>
              <select id="igSize">
                <option value="1024x1024">1024×1024</option>
                <option value="960x1280">960×1280</option>
                <option value="768x1024">768×1024</option>
                <option value="720x1440">720×1440</option>
              </select>
            </div>
            <div>
              <label for="igSteps">步数</label>
              <input id="igSteps" type="number" min="1" max="50" value="20" />
            </div>
          </div>
          <label for="igGuidance">引导系数</label>
          <input id="igGuidance" type="number" min="1" max="20" step="0.5" value="7.5" />
          <div class="image-gen-actions">
            <button type="button" class="btn-cancel" id="igCancel">取消</button>
            <button type="submit" class="btn-generate" id="igSubmit">生成</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    requestAnimationFrame(() => overlay.classList.add('show'));

    overlay.querySelector('.close-btn')?.addEventListener('click', () => this.close());
    overlay.querySelector('#igCancel')?.addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector('#imageGenForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const prompt = overlay.querySelector('#igPrompt')?.value?.trim() || '';
      const negativePrompt = overlay.querySelector('#igNegative')?.value?.trim() || '';
      const size = overlay.querySelector('#igSize')?.value;
      const steps = parseInt(overlay.querySelector('#igSteps')?.value || '20', 10);
      const guidance = parseFloat(overlay.querySelector('#igGuidance')?.value || '7.5');
      this.close();
      window.ImageGenHandler?.generate({ prompt, negativePrompt, size, steps, guidance });
    });

    setTimeout(() => overlay.querySelector('#igPrompt')?.focus(), 200);
  },

  close() {
    if (!this.overlay) return;
    const el = this.overlay;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
    this.overlay = null;
  }
};

if (typeof window !== 'undefined') window.ImageGenUI = ImageGenUI;
