/**
 * Markdown 源码/渲染切换
 */
const MarkdownHandler = {
  toggleView(messageId) {
    const el = document.getElementById(messageId);
    if (!el) return;

    const isRendered = el.dataset.isRendered === 'true';
    const original = el.dataset.original || '';
    const toggle = el.querySelector('.markdown-toggle');

    if (isRendered) {
      el.classList.remove('markdown-rendered');
      el.textContent = original;
      if (toggle) el.appendChild(toggle);
      else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'markdown-toggle';
        btn.title = '切换源码/渲染';
        btn.textContent = '📝';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleView(messageId);
        });
        el.appendChild(btn);
      }
      el.dataset.isRendered = 'false';
    } else {
      el.classList.add('markdown-rendered');
      el.innerHTML = Utils.markdown.renderToHtml(original);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'markdown-toggle';
      btn.title = '切换源码/渲染';
      btn.textContent = '📝';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleView(messageId);
      });
      el.appendChild(btn);
      el.dataset.isRendered = 'true';
    }
  }
};

if (typeof window !== 'undefined') window.MarkdownHandler = MarkdownHandler;
