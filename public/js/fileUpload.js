/**
 * 文件上传 v2
 */
const FileUpload = {
  isDragging: false,
  dragCounter: 0,
  uploading: false,

  init() {
    this.bindEvents();
    this.createDragOverlay();
    this.setupClipboardListener();
  },

  bindEvents() {
    const fileInput = document.getElementById('fileInput');
    const imageInput = document.getElementById('imageInput');
    const cameraInput = document.getElementById('cameraInput');
    const fileButton = document.getElementById('fileButton');

    fileButton?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });
    imageInput?.addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });
    cameraInput?.addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });

    document.addEventListener('dragenter', this.handleDragEnter.bind(this));
    document.addEventListener('dragover', this.handleDragOver.bind(this));
    document.addEventListener('dragleave', this.handleDragLeave.bind(this));
    document.addEventListener('drop', this.handleDrop.bind(this));
  },

  createDragOverlay() {
    if (document.getElementById('dragOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'dragOverlay';
    overlay.className = 'drag-overlay';
    overlay.innerHTML = `
      <div class="drag-content">
        <div class="drag-icon">📁</div>
        <div class="drag-text">拖拽文件到此处上传</div>
        <div class="drag-hint">支持多文件同时上传</div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  setupClipboardListener() {
    document.addEventListener('paste', this.handlePaste.bind(this));
  },

  async handleFileSelect(fileList) {
    if (!fileList || !fileList.length) return;
    await this.uploadMultipleFiles(Array.from(fileList));
  },

  handleDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dragCounter += 1;
    if (e.dataTransfer?.types?.includes('Files')) {
      this.isDragging = true;
      document.getElementById('dragOverlay')?.classList.add('show');
    }
  },

  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
  },

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dragCounter = Math.max(0, this.dragCounter - 1);
    if (this.dragCounter === 0) {
      this.isDragging = false;
      document.getElementById('dragOverlay')?.classList.remove('show');
    }
  },

  async handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dragCounter = 0;
    this.isDragging = false;
    document.getElementById('dragOverlay')?.classList.remove('show');
    const files = e.dataTransfer?.files;
    if (files?.length) await this.uploadMultipleFiles(Array.from(files));
  },

  async handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await this.uploadMultipleFiles(files);
    }
  },

  validateFile(file) {
    if (!file) return '无效文件';
    // 上限以服务端 MAX_FILE_SIZE 为准（0 = 不限制），拿不到时回落到前端默认
    const limit = ServerConfig?.maxFileSize?.() ?? CONFIG.FILE.MAX_SIZE;
    if (limit > 0 && file.size > limit) {
      const text = CONFIG.RUNTIME.maxFileSizeText || Utils.formatFileSize(limit);
      return `${CONFIG.ERRORS.FILE_TOO_LARGE}（最大 ${text}）`;
    }
    return null;
  },

  async uploadMultipleFiles(files) {
    if (this.uploading) {
      Utils.showToast('正在上传中，请稍候', 'info');
      return;
    }
    const valid = [];
    for (const f of files) {
      const err = this.validateFile(f);
      if (err) Utils.showToast(`${f.name}: ${err}`, 'error');
      else valid.push(f);
    }
    if (!valid.length) return;

    this.uploading = true;
    const deviceId = Utils.getDeviceId();
    try {
      for (let i = 0; i < valid.length; i++) {
        const file = valid[i];
        const prefix = `上传中 (${i + 1}/${valid.length}) ${file.name}`;
        UI.showUploadStatus(true, prefix, 0, '');

        await API.uploadFile(file, deviceId, (info) => {
          // 进度条 + 实时速度 + 已传/总量，便于判断是否卡住
          const detail = `${prefix} · ${Utils.formatFileSize(info.loaded)}/${Utils.formatFileSize(info.total)}`;
          UI.showUploadStatus(true, detail, info.percent, info.speedText);
        });
      }
      UI.showUploadStatus(false);
      Utils.showToast(CONFIG.SUCCESS.FILE_UPLOADED, 'success');
      MessageHandler.loadMessages(true);
    } catch (e) {
      UI.showUploadStatus(false);
      Utils.showToast(e.message || CONFIG.ERRORS.FILE_UPLOAD_FAILED, 'error');
    } finally {
      this.uploading = false;
    }
  },

  /**
   * 下载文件
   *
   * 桌面端：流式读取 + 进度条 + 实时速度，走完才提示「下载完成」。
   * 移动端：交给浏览器原生下载器，前端不显示进度条。
   *
   * ⚠ 移动端**绝不能**沿用「下载完成」这句提示。
   *   实测（Android 微信/UC/夸克一类 WebView 浏览器）：`API.downloadFile` 会正常
   *   返回，但那是「已经把请求交给了浏览器」，文件到底有没有落盘，
   *   前端**根本无从得知**。此时弹「下载完成」是在撒谎 ——
   *   用户截图里的现象正是如此：提示已下载完成，下载列表里却什么都没有。
   */
  async downloadWithProgress(r2Key, fileName) {
    if (!r2Key) return;

    if (Utils.useNativeDownload()) {
      try {
        await API.downloadFile(r2Key, fileName);
        Utils.showToast('已开始下载，请在浏览器的「下载」中查看', 'info');
      } catch (e) {
        // API.downloadFile 内部已提示，这里不重复弹错
        console.warn('[FileUpload] download failed', e);
      }
      return;
    }

    const prefix = `下载中 ${fileName || ''}`.trim();
    UI.showUploadStatus(true, prefix, 0, '');
    try {
      await API.downloadFile(r2Key, fileName, (info) => {
        const detail = `${prefix} · ${Utils.formatFileSize(info.loaded)}/${Utils.formatFileSize(info.total)}`;
        UI.showUploadStatus(true, detail, info.percent, info.speedText);
      });
      UI.showUploadStatus(false);
      Utils.showToast('下载完成', 'success');
    } catch (e) {
      UI.showUploadStatus(false);
      // API.downloadFile 内部已提示，这里不重复弹错
      console.warn('[FileUpload] download failed', e);
    }
  },

  openAlbum() {
    document.getElementById('imageInput')?.click();
  },

  openCamera() {
    document.getElementById('cameraInput')?.click();
  },

  openFiles() {
    document.getElementById('fileInput')?.click();
  }
};

if (typeof window !== 'undefined') window.FileUpload = FileUpload;
