import { Hono } from 'hono'
import { FileService } from '../services/fileService.js'
import { MessageService } from '../services/messageService.js'
import { validateParams, ok, fail, AppError } from '../middleware/errorHandler.js'

const files = new Hono()

files.post('/upload', async (c) => {
  const { DB, R2 } = c.env
  let r2Key = null
  try {
    const formData = await c.req.formData()
    const file = formData.get('file')
    const deviceId = formData.get('deviceId')

    if (!file || typeof file === 'string') {
      throw new AppError('缺少文件', 400, 'MISSING_FILE')
    }
    validateParams({ deviceId }, ['deviceId'])

    const maxSize = parseInt(c.env.MAX_FILE_SIZE || '0', 10)
    if (maxSize > 0 && file.size > maxSize) {
      throw new AppError(`文件大小超过限制（最大 ${Math.round(maxSize / 1024 / 1024)}MB）`, 400, 'FILE_TOO_LARGE')
    }

    r2Key = FileService.generateR2Key(file.name || 'file.bin')
    await FileService.uploadToR2(R2, r2Key, file.stream(), {
      contentType: file.type,
      fileName: file.name || 'file.bin'
    })

    try {
      const fileRecord = await FileService.saveFileRecord(DB, {
        fileName: file.name || 'file.bin',
        r2Key,
        fileSize: file.size,
        mimeType: file.type,
        deviceId
      })
      await MessageService.createFileMessage(DB, fileRecord.id, deviceId)

      return ok(c, {
        fileId: fileRecord.id,
        fileName: file.name || 'file.bin',
        fileSize: file.size,
        r2Key
      })
    } catch (dbError) {
      console.error('[Files] 数据库失败，回滚 R2:', dbError)
      await FileService.deleteFromR2(R2, r2Key)
      throw new AppError(`数据库操作失败: ${dbError.message}`, 500, 'DB_ERROR')
    }
  } catch (error) {
    console.error('[Files] 上传失败:', error)
    return fail(c, error)
  }
})

files.get('/download/:r2Key{.+}', async (c) => {
  try {
    const { DB, R2 } = c.env
    // 兼容 files/xxx 带路径的 key
    const r2Key = c.req.param('r2Key')

    const fileInfo = await FileService.getFileByR2Key(DB, r2Key)
    if (!fileInfo) {
      return fail(c, new AppError('文件不存在', 404, 'FILE_NOT_FOUND'))
    }

    const object = await FileService.getFromR2(R2, r2Key)
    if (!object) {
      return fail(c, new AppError('文件不存在', 404, 'FILE_NOT_FOUND'))
    }

    c.executionCtx.waitUntil(FileService.incrementDownloadCount(DB, r2Key))

    /**
     * Content-Disposition 构造（Node 运行时适配）
     *
     * 上游直接把 original_name 塞进 filename="..."，Cloudflare Workers 能容忍
     * 非 ASCII 头值；但 Node/undici 要求 header 必须是 ByteString（每个字符 <= 255），
     * 遇到「自检文件.txt」这类中文名会抛：
     *   TypeError: Cannot convert argument to a ByteString ...
     * 导致所有中文名文件下载 500。
     *
     * 正确做法（RFC 6266 / RFC 5987）：
     *   - filename=        只放 ASCII 安全名（非 ASCII 一律降级为 _）
     *   - filename*=UTF-8'' 放完整的百分号编码名，现代浏览器优先用它
     */
    const rawName = String(fileInfo.original_name || 'file')
    const asciiName = rawName
      .replace(/[^\x20-\x7E]/g, '_')   // 非 ASCII → _
      .replace(/["\\\r\n]/g, '_')       // 引号与换行 → _
      .slice(0, 150) || 'file'

    const headers = {
      'Content-Type': fileInfo.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
      'Cache-Control': 'private, max-age=3600',
      // 下载直链要带 `?token=`（浏览器原生下载是顶层导航，没法设 Authorization 头），
      // 于是**凭据出现在 URL 里**。URL 会流窜到浏览器历史、反向代理的 access log，
      // 以及（若响应被渲染而非下载时）跨站请求的 Referer。
      // no-referrer 把最后一条堵死：不让本响应里的 token 通过 Referer 泄给第三方。
      //
      // 注意另外两条堵不住，属于「用 query 传凭据」的固有代价：
      //   - nginx/Caddy 的 access log 里会有完整 URL（应用自身不记 URL，但代理会）
      //   - 浏览器历史里会留一条 24 小时有效的链接
      // 想彻底避免，需要改成 Cookie 或短时效的一次性下载票据 —— 那是设计变更，
      // 当前版本权衡后接受这个代价（EventSource 早就用 `?token=` 了，并非新引入）。
      'Referrer-Policy': 'no-referrer',
      // 用户可上传任意类型文件。虽然 attachment 已经让它不会被就地渲染，
      // 仍加上 nosniff 作为纵深防御，避免 MIME 嗅探把上传内容当脚本执行。
      'X-Content-Type-Options': 'nosniff'
    }

    // file_size 可能为 0 或缺失，空值不能作为 Content-Length 下发
    const size = Number(fileInfo.file_size)
    if (Number.isFinite(size) && size > 0) {
      headers['Content-Length'] = String(size)
    }

    return new Response(object.body, { headers })
  } catch (error) {
    console.error('[Files] 下载失败:', error)
    return fail(c, error)
  }
})

export default files
