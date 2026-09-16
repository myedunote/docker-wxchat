import { DBService } from './database.js'
import { AppError } from '../middleware/errorHandler.js'

export const FileService = {
  generateR2Key(fileName) {
    const timestamp = Date.now()
    const randomStr = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const rawExt = (fileName || '').includes('.')
      ? fileName.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'bin'
    const ext = rawExt || 'bin'
    return `files/${timestamp}-${randomStr}.${ext}`
  },

  async uploadToR2(r2, r2Key, body, { contentType, fileName }) {
    if (!r2) throw new AppError('R2 存储未绑定', 500, 'R2_UNBOUND')
    const safeName = String(fileName || 'file').replace(/["\r\n]/g, '_')
    try {
      await r2.put(r2Key, body, {
        httpMetadata: {
          contentType: contentType || 'application/octet-stream',
          contentDisposition: `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
        }
      })
    } catch (error) {
      console.error('[FileService] R2上传失败:', error)
      throw new AppError(`文件上传到存储失败: ${error.message}`, 500, 'R2_UPLOAD_FAILED')
    }
  },

  async deleteFromR2(r2, r2Key) {
    if (!r2 || !r2Key) return false
    try {
      await r2.delete(r2Key)
      return true
    } catch (error) {
      console.error('[FileService] R2删除失败:', error)
      return false
    }
  },

  async getFromR2(r2, r2Key) {
    if (!r2) throw new AppError('R2 存储未绑定', 500, 'R2_UNBOUND')
    try {
      return await r2.get(r2Key)
    } catch (error) {
      console.error('[FileService] R2获取失败:', error)
      throw new AppError(`文件获取失败: ${error.message}`, 500, 'R2_GET_FAILED')
    }
  },

  async saveFileRecord(db, { fileName, r2Key, fileSize, mimeType, deviceId }) {
    const result = await DBService.execute(db,
      `INSERT INTO files (original_name, file_name, file_size, mime_type, r2_key, upload_device_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fileName, r2Key, fileSize, mimeType || 'application/octet-stream', r2Key, deviceId]
    )
    return { id: result.meta.last_row_id }
  },

  async getFileByR2Key(db, r2Key) {
    return DBService.queryFirst(db, `SELECT * FROM files WHERE r2_key = ?`, [r2Key])
  },

  async incrementDownloadCount(db, r2Key) {
    await DBService.execute(db,
      `UPDATE files SET download_count = download_count + 1, updated_at = datetime('now') WHERE r2_key = ?`,
      [r2Key]
    )
  },

  async getAllR2Keys(db) {
    const result = await DBService.queryAll(db, `SELECT r2_key FROM files`)
    return (result.results || []).map((r) => r.r2_key)
  },

  async deleteAll(db) {
    await DBService.execute(db, `DELETE FROM files`)
  },

  async getStats(db) {
    return DBService.queryFirst(db,
      `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize FROM files`
    )
  }
}
