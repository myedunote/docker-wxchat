/**
 * 图片懒加载 + 灯箱
 */
const ImageLoader = {
  async load(r2Key, safeId) {
    const img = document.getElementById(`img-${safeId}`);
    const loading = document.getElementById(`loading-${safeId}`);
    const error = document.getElementById(`error-${safeId}`);
    if (!img) return;

    try {
      if (loading) loading.style.display = 'flex';
      if (error) error.style.display = 'none';
      img.style.display = 'none';

      const url = await API.getImageBlobUrl(r2Key);
      img.src = url;
      img.alt = '图片预览';
      img.onload = () => {
        if (loading) loading.style.display = 'none';
        img.style.display = 'block';
      };
      img.onerror = () => this.showError(safeId);
      img.onclick = () => this.openLightbox(url);
    } catch (e) {
      console.warn('[ImageLoader]', e);
      this.showError(safeId);
    }
  },

  retry(r2Key, safeId) {
    API.revokeImageBlobUrl(r2Key);
    this.load(r2Key, safeId);
  },

  showError(safeId) {
    const img = document.getElementById(`img-${safeId}`);
    const loading = document.getElementById(`loading-${safeId}`);
    const error = document.getElementById(`error-${safeId}`);
    if (loading) loading.style.display = 'none';
    if (img) img.style.display = 'none';
    if (error) error.style.display = 'flex';
  },

  openLightbox(url) {
    document.querySelector('.lightbox')?.remove();
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <button type="button" class="lightbox-close" aria-label="关闭">×</button>
      <img src="${url}" alt="预览" />
    `;
    const close = () => box.remove();
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.classList.contains('lightbox-close')) close();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    });
    document.body.appendChild(box);
  }
};

if (typeof window !== 'undefined') window.ImageLoader = ImageLoader;
