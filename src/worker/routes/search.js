import { Hono } from 'hono'
import { ok, fail } from '../middleware/errorHandler.js'

const search = new Hono()

const FILE_TYPE_MAP = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/svg+xml', 'image/webp', 'image/heic'],
  video: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/mkv', 'video/flv', 'video/webm'],
  audio: ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/m4a'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ],
  archive: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip'],
  text: ['text/plain', 'text/html', 'text/css', 'text/javascript', 'text/markdown', 'text/csv'],
  code: ['application/javascript', 'application/json', 'application/xml']
}

function escapeLike(q) {
  return String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

search.get('/', async (c) => {
  try {
    const { DB } = c.env
    const query = (c.req.query('q') || '').trim()
    const type = c.req.query('type') || 'all'
    const timeRange = c.req.query('timeRange') || 'all'
    const deviceId = c.req.query('deviceId') || 'all'
    const fileType = c.req.query('fileType') || 'all'
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 200)
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0)

    if (!query) {
      return fail(c, { message: '搜索关键词不能为空', status: 400, code: 'EMPTY_QUERY' })
    }

    const like = `%${escapeLike(query)}%`
    const textMatch = `(m.content LIKE ? ESCAPE '\\' AND m.type IN ('text','ai','system'))`
    const fileMatch = `(f.original_name LIKE ? ESCAPE '\\' AND m.type = 'file')`

    // 匹配条件：文本 OR 文件名（按 type 过滤）
    const matchParts = []
    const matchParams = []
    if (type === 'all' || type === 'text') {
      matchParts.push(textMatch)
      matchParams.push(like)
    }
    if (type === 'all' || type === 'file') {
      matchParts.push(fileMatch)
      matchParams.push(like)
    }
    if (matchParts.length === 0) {
      return fail(c, { message: '无效的搜索类型', status: 400, code: 'BAD_TYPE' })
    }

    // 过滤条件全部 AND
    const filters = []
    const filterParams = []

    if (timeRange !== 'all') {
      const timeMap = {
        today: `m.timestamp >= datetime('now', 'start of day')`,
        yesterday: `m.timestamp >= datetime('now', '-1 day', 'start of day') AND m.timestamp < datetime('now', 'start of day')`,
        week: `m.timestamp >= datetime('now', '-7 days')`,
        month: `m.timestamp >= datetime('now', '-30 days')`
      }
      if (timeMap[timeRange]) filters.push(`(${timeMap[timeRange]})`)
    }

    if (deviceId !== 'all') {
      filters.push('m.device_id = ?')
      filterParams.push(deviceId)
    }

    let needsFileJoin = type === 'all' || type === 'file' || fileType !== 'all'
    if (fileType !== 'all' && (type === 'all' || type === 'file')) {
      needsFileJoin = true
      const mimeTypes = FILE_TYPE_MAP[fileType] || []
      if (mimeTypes.length > 0) {
        filters.push(`(f.mime_type IN (${mimeTypes.map(() => '?').join(',')}))`)
        filterParams.push(...mimeTypes)
      }
    }

    const where = `WHERE (${matchParts.join(' OR ')})` +
      (filters.length ? ` AND ${filters.join(' AND ')}` : '')
    const joinClause = needsFileJoin ? 'LEFT JOIN files f ON m.file_id = f.id' : 'LEFT JOIN files f ON m.file_id = f.id'

    const selectFields = `
      m.id, m.type, m.content, m.device_id, m.timestamp, m.meta,
      f.original_name, f.file_size, f.mime_type, f.r2_key
    `

    const baseParams = [...matchParams, ...filterParams]
    const [countResult, dataResult] = await Promise.all([
      DB.prepare(`SELECT COUNT(DISTINCT m.id) as total FROM messages m ${joinClause} ${where}`)
        .bind(...baseParams).first(),
      DB.prepare(
        `SELECT ${selectFields} FROM messages m ${joinClause} ${where}
         ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`
      ).bind(...baseParams, limit, offset).all()
    ])

    return c.json({
      success: true,
      data: dataResult.results || [],
      total: countResult?.total || 0,
      limit,
      offset,
      query: { q: query, type, timeRange, deviceId, fileType }
    })
  } catch (error) {
    console.error('[Search] 失败:', error)
    return fail(c, error)
  }
})

search.get('/suggestions', async (c) => {
  try {
    const { DB } = c.env
    const query = (c.req.query('q') || '').trim()
    if (query.length < 2) {
      return ok(c, [])
    }
    const like = `%${escapeLike(query)}%`
    const result = await DB.prepare(`
      SELECT DISTINCT substr(m.content, 1, 50) as suggestion
      FROM messages m
      WHERE m.type IN ('text','ai') AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.timestamp DESC
      LIMIT 10
    `).bind(like).all()

    return ok(c, (result.results || []).map((r) => r.suggestion).filter(Boolean))
  } catch (error) {
    console.error('[Search] 建议失败:', error)
    return ok(c, [])
  }
})

export default search
