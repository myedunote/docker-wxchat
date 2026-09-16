/**
 * AI UI 辅助
 */
const AIUI = {
  init() {
    return true;
  },

  createStreamingBubble() {
    const root = document.createElement('div');
    root.className = 'message ai streaming';
    root.innerHTML = `
      <div class="message-avatar">AI</div>
      <div class="message-body">
        <div class="message-sender">AI助手</div>
        <div class="message-bubble">
          <div class="ai-thinking" style="display:none">
            <summary style="cursor:pointer;list-style:none">思考中...</summary>
            <div class="ai-thinking-body"></div>
          </div>
          <div class="text-message streaming-cursor"></div>
        </div>
      </div>
    `;
    const list = document.getElementById('messageList');
    list?.appendChild(root);
    UI.scrollToBottom(true);
    return root;
  },

  updateStreaming(el, text, thinking) {
    if (!el) return;
    const textEl = el.querySelector('.text-message');
    const thinkWrap = el.querySelector('.ai-thinking');
    const thinkBody = el.querySelector('.ai-thinking-body');
    if (thinking && thinkWrap && thinkBody) {
      thinkWrap.style.display = 'block';
      thinkBody.textContent = thinking;
    }
    if (textEl) {
      if (Utils.markdown.hasMarkdownSyntax(text)) {
        textEl.classList.add('markdown-rendered');
        textEl.innerHTML = Utils.markdown.renderToHtml(text);
      } else {
        textEl.textContent = text;
      }
      textEl.classList.add('streaming-cursor');
    }
    UI.scrollToBottom();
  },

  completeStreaming(el) {
    el?.classList.remove('streaming');
    el?.querySelector('.text-message')?.classList.remove('streaming-cursor');
  }
};

if (typeof window !== 'undefined') window.AIUI = AIUI;
