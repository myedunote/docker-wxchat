/**
 * 消息渲染器 v2 — 微信气泡
 */
const MessageRenderer = {
  createMessageElement(message, currentDeviceId) {
    const type = message.type || 'text';
    if (type === 'system') {
      return this.createSystemMessage(message);
    }

    const isOwn = message.device_id === currentDeviceId && type !== 'ai';
    const isAI = type === 'ai' || message.device_id === 'ai-system';
    const time = Utils.formatTime(message.timestamp);
    const sender = isAI ? 'AI助手' : (isOwn ? '我' : '其他设备');
    const avatarText = isAI ? 'AI' : (isOwn ? '我' : '他');

    const root = document.createElement('div');
    root.className = `message ${isAI ? 'ai' : (isOwn ? 'own' : 'other')}`;
    if (message._optimistic || message.status === 'sending') root.classList.add('pending');
    if (message.status === 'failed') root.classList.add('failed');
    root.dataset.messageId = message.id;
    root.dataset.timestamp = message.timestamp || '';
    root.dataset.type = type;
    if (message._optimistic) root.dataset.optimistic = '1';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = avatarText;
    avatar.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'message-body';

    const senderEl = document.createElement('div');
    senderEl.className = 'message-sender';
    senderEl.textContent = sender;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (type === 'file') {
      bubble.appendChild(this.renderFileContent(message));
    } else {
      bubble.appendChild(this.renderTextContent(message, isAI));
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = `<span class="message-time">${Utils.escapeHtml(time)}</span>`;

    // 消息操作：一键复制 / 删除单条（乐观消息尚未入库，不提供）
    if (!message._optimistic && message.id != null) {
      meta.appendChild(this.createActions(message));
    }

    body.appendChild(senderEl);
    body.appendChild(bubble);
    body.appendChild(meta);

    root.appendChild(avatar);
    root.appendChild(body);

    // 长按 / 右键菜单
    this.bindContext(root, message);

    return root;
  },

  /**
   * 消息操作按钮组（悬停/聚焦时显示）
   * 复制：一键把消息内容或文件名写入剪贴板
   * 删除：只删这一条，二次确认后调用后端 DELETE /api/messages/:id
   */
  createActions(message) {
    const wrap = document.createElement('span');
    wrap.className = 'message-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'message-action-btn';
    copyBtn.title = '复制';
    copyBtn.setAttribute('aria-label', '复制消息内容');
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      MessageRenderer.copyMessage(message);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'message-action-btn danger';
    delBtn.title = '删除';
    delBtn.setAttribute('aria-label', '删除这条消息');
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      MessageRenderer.deleteMessage(message);
    });

    wrap.appendChild(copyBtn);
    wrap.appendChild(delBtn);
    return wrap;
  },

  /** 一键复制：文本用 content，文件消息回落到文件名 */
  async copyMessage(message) {
    const text = message.type === 'file'
      ? (message.original_name || message.content || '')
      : (message.content || '');
    const ok = await Utils.copyText(text);
    if (ok) Utils.showToast('已复制', 'success');
    else Utils.showToast('复制失败，请手动选择文本', 'error');
    return ok;
  },

  /** 下载文件：走带进度与速度的下载通道 */
  downloadFile(message) {
    if (!message?.r2_key) return;
    const fn = window.FileUpload?.downloadWithProgress;
    if (typeof fn === 'function') {
      fn.call(FileUpload, message.r2_key, message.original_name);
    } else {
      API.downloadFile(message.r2_key, message.original_name);
    }
  },

  /** 删除单条消息：二次确认后调用后端，并同步移除 DOM */
  async deleteMessage(message) {
    if (message?._optimistic || message?.id == null) return false;

    const ok = await Utils.confirmDialog({
      title: '删除这条消息',
      message: message.type === 'file'
        ? `将删除文件「${message.original_name || '文件'}」及其记录，且无法恢复。`
        : '删除后无法恢复，确定继续吗？',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (ok !== true) return false;

    return MessageHandler?.deleteMessage?.(message.id);
  },

  createSystemMessage(message) {
    const root = document.createElement('div');
    root.className = 'message system';
    root.dataset.messageId = message.id;
    root.dataset.timestamp = message.timestamp || '';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.content || '';
    root.appendChild(bubble);
    return root;
  },

  createDateSeparator(timestamp) {
    const el = document.createElement('div');
    el.className = 'date-separator';
    el.innerHTML = `<span>${Utils.escapeHtml(Utils.formatDateSeparator(timestamp))}</span>`;
    el.dataset.date = Utils.formatDateSeparator(timestamp);
    return el;
  },

  renderTextContent(message, isAI = false) {
    const wrap = document.createElement('div');
    const content = message.content || '';
    const hasMd = Utils.markdown.hasMarkdownSyntax(content);
    const messageId = `msg-${message.id}`;

    // AI thinking meta
    let thinking = null;
    try {
      if (message.meta) {
        const meta = typeof message.meta === 'string' ? JSON.parse(message.meta) : message.meta;
        if (meta?.thinking) thinking = meta.thinking;
      }
    } catch { /* ignore */ }

    if (thinking) {
      const details = document.createElement('details');
      details.className = 'ai-thinking';
      details.innerHTML = `<summary>思考过程</summary><div class="ai-thinking-body"></div>`;
      details.querySelector('.ai-thinking-body').textContent = thinking;
      wrap.appendChild(details);
    }

    const textEl = document.createElement('div');
    textEl.className = hasMd ? 'text-message markdown-rendered' : 'text-message';
    textEl.id = messageId;
    textEl.dataset.original = content;
    textEl.dataset.isRendered = hasMd ? 'true' : 'false';

    if (hasMd) {
      textEl.innerHTML = Utils.markdown.renderToHtml(content);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'markdown-toggle';
      btn.title = '切换源码/渲染';
      btn.textContent = '📝';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        MarkdownHandler.toggleView(messageId);
      });
      textEl.appendChild(btn);
    } else {
      textEl.textContent = content;
    }

    wrap.appendChild(textEl);
    return wrap;
  },

  renderFileContent(message) {
    const wrap = document.createElement('div');
    wrap.className = 'file-message';

    const card = document.createElement('div');
    card.className = 'file-card';

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = Utils.getFileIcon(message.mime_type, message.original_name);

    const info = document.createElement('div');
    info.className = 'file-info';
    info.innerHTML = `
      <div class="file-name"></div>
      <div class="file-size"></div>
    `;
    info.querySelector('.file-name').textContent = message.original_name || '文件';
    info.querySelector('.file-size').textContent = Utils.formatFileSize(message.file_size);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-download-btn';
    btn.title = '下载';
    btn.setAttribute('aria-label', '下载文件');
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM12 2v12l4-4 1.4 1.4L12 18.8 6.6 11.4 8 10l4 4V2z"/></svg>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      MessageRenderer.downloadFile(message);
    });

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(btn);
    wrap.appendChild(card);

    if (Utils.isImageFile(message.mime_type, message.original_name) && message.r2_key) {
      const safeId = this.createSafeId(message.r2_key);
      const preview = document.createElement('div');
      preview.className = 'image-preview';
      preview.id = `preview-${safeId}`;
      preview.innerHTML = `
        <div class="image-loading" id="loading-${safeId}">
          <div class="spinner"></div>
          <span>加载中...</span>
        </div>
        <img id="img-${safeId}" alt="" style="display:none" />
        <div class="image-error" id="error-${safeId}" style="display:none">
          <span>图片加载失败</span>
          <button type="button" class="retry-btn">重试</button>
        </div>
      `;
      preview.querySelector('.retry-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        ImageLoader.retry(message.r2_key, safeId);
      });
      wrap.appendChild(preview);
      message._needsImageLoad = { r2Key: message.r2_key, safeId };
    }

    return wrap;
  },

  createSafeId(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  },

  bindContext(root, message) {
    let timer = null;
    const showMenu = (x, y) => {
      document.querySelector('.context-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
      menu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'context-menu-item';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', async () => {
        menu.remove();
        await MessageRenderer.copyMessage(message);
      });
      menu.appendChild(copyBtn);

      if (message.type === 'file' && message.r2_key) {
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'context-menu-item';
        dl.textContent = '下载';
        dl.addEventListener('click', () => {
          API.downloadFile(message.r2_key, message.original_name);
          menu.remove();
        });
        menu.appendChild(dl);
      }

      // 删除单条消息
      if (!message._optimistic && message.id != null) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'context-menu-item danger';
        del.textContent = '删除';
        del.addEventListener('click', async () => {
          menu.remove();
          await MessageRenderer.deleteMessage(message);
        });
        menu.appendChild(del);
      }

      document.body.appendChild(menu);
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('pointerdown', close, true);
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    };

    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY);
    });

    root.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      timer = setTimeout(() => showMenu(t.clientX, t.clientY), 480);
    }, { passive: true });
    root.addEventListener('touchend', () => clearTimeout(timer));
    root.addEventListener('touchmove', () => clearTimeout(timer));
  }
};

if (typeof window !== 'undefined') window.MessageRenderer = MessageRenderer;
