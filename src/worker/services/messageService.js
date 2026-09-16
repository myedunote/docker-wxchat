import { DBService } from './database.js'

const SELECT_FIELDS = `
  m.id,
  m.type,
  m.content,
  m.device_id,
  m.status,
  m.meta,
  m.timestamp,
  f.original_name,
  f.file_size,
  f.mime_type,
  f.r2_key
`

/**
 * Docker 版可配置分页上限。
 * 上游把上限写死成 200，自托管场景下用户希望一次能拉回全部历史，
 * 因此改为读环境变量：
 *   MESSAGE_LOAD_DEFAULT 默认单页条数（默认 5000）
 *   MESSAGE_LOAD_MAX     单页硬上限（默认 100000）
 * 注意：上限只影响「单次查询返回多少条」，不会删除任何历史数据。
 */
function loadDefault() {
  const n = Number.parseInt(process.env.MESSAGE_LOAD_DEFAULT || '', 10)
  return Number.isFinite(n) && n > 0 ? n : 5000
}

function loadMax() {
  const n = Number.parseInt(process.env.MESSAGE_LOAD_MAX || '', 10)
  return Number.isFinite(n) && n > 0 ? n : 100000
}

/** 把外部传入的 limit 夹到 [1, MESSAGE_LOAD_MAX] */
function normalizeLimit(limit, fallback) {
  const max = loadMax()
  const parsed = Number.parseInt(limit, 10)
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  return Math.min(Math.max(1, base), max)
}

export const MessageService = {
  loadDefault,
  loadMax,

  async getMessages(db, { limit, offset = 0, beforeId = null, afterId = null } = {}) {
    const limitNum = normalizeLimit(limit, loadDefault())
    const offsetNum = Math.max(0, parseInt(offset, 10) || 0)

    let sql
    let params

    if (afterId) {
      // 增量：取 id > afterId 的新消息（正序）
      sql = `
        SELECT ${SELECT_FIELDS}
        FROM messages m
        LEFT JOIN files f ON m.file_id = f.id
        WHERE m.id > ?
        ORDER BY m.id ASC
        LIMIT ?
      `
      params = [parseInt(afterId, 10) || 0, limitNum]
    } else if (beforeId) {
      // 历史：取 id < beforeId 的旧消息，再在服务端反转为正序
      sql = `
        SELECT ${SELECT_FIELDS}
        FROM messages m
        LEFT JOIN files f ON m.file_id = f.id
        WHERE m.id < ?
        ORDER BY m.id DESC
        LIMIT ?
      `
      params = [parseInt(beforeId, 10) || 0, limitNum]
    } else {
      // 默认：最新一页（倒序取再翻转），offset 兼容旧客户端
      if (offsetNum > 0) {
        sql = `
          SELECT ${SELECT_FIELDS}
          FROM messages m
          LEFT JOIN files f ON m.file_id = f.id
          ORDER BY m.id ASC
          LIMIT ? OFFSET ?
        `
        params = [limitNum, offsetNum]
      } else {
        sql = `
          SELECT ${SELECT_FIELDS}
          FROM messages m
          LEFT JOIN files f ON m.file_id = f.id
          ORDER BY m.id DESC
          LIMIT ?
        `
        params = [limitNum]
      }
    }

    const countSql = `SELECT COUNT(*) as total FROM messages`
    const [dataResult, countResult] = await Promise.all([
      DBService.queryAll(db, sql, params),
      DBService.queryFirst(db, countSql)
    ])

    let rows = dataResult.results || []
    // beforeId / 默认最新页 都是 DESC 取的，需要翻成时间正序
    if (beforeId || (!afterId && offsetNum === 0)) {
      rows = rows.slice().reverse()
    }

    return {
      data: rows,
      total: countResult?.total || 0,
      limit: limitNum,
      offset: offsetNum
    }
  },

  async createMessage(db, { type = 'text', content, deviceId, meta = null }) {
    const result = await DBService.execute(db,
      `INSERT INTO messages (type, content, device_id, meta, status) VALUES (?, ?, ?, ?, 'sent')`,
      [type, content, deviceId, meta]
    )
    return { id: result.meta.last_row_id }
  },

  async createFileMessage(db, fileId, deviceId) {
    const result = await DBService.execute(db,
      `INSERT INTO messages (type, file_id, device_id, status) VALUES (?, ?, ?, 'sent')`,
      ['file', fileId, deviceId]
    )
    return { id: result.meta.last_row_id }
  },

  async createAIMessage(db, { content, deviceId, type = 'ai_response' }) {
    const meta = JSON.stringify({ aiType: type })
    const result = await DBService.execute(db,
      `INSERT INTO messages (type, content, device_id, meta, status) VALUES (?, ?, ?, ?, 'sent')`,
      ['ai', content, deviceId || 'ai-system', meta]
    )
    return {
      id: result.meta.last_row_id,
      type: 'ai',
      content,
      device_id: deviceId || 'ai-system',
      timestamp: new Date().toISOString(),
      meta,
      originalType: type
    }
  },

  async getNewMessageCount(db, lastMessageId = '0') {
    const result = await DBService.queryFirst(db,
      `SELECT COUNT(*) as count FROM messages WHERE id > ?`,
      [parseInt(lastMessageId, 10) || 0]
    )
    return result?.count || 0
  },

  async getLatestMessageId(db) {
    const result = await DBService.queryFirst(db, `SELECT MAX(id) as maxId FROM messages`)
    return result?.maxId || 0
  },

  async getMessagesSince(db, lastMessageId = 0, limit = 50) {
    const limitNum = normalizeLimit(limit, 50)
    const result = await DBService.queryAll(db, `
      SELECT ${SELECT_FIELDS}
      FROM messages m
      LEFT JOIN files f ON m.file_id = f.id
      WHERE m.id > ?
      ORDER BY m.id ASC
      LIMIT ?
    `, [parseInt(lastMessageId, 10) || 0, limitNum])
    return result.results || []
  },

  /** 取单条消息（含文件信息），用于删除前校验与回包 */
  async getMessageById(db, id) {
    const result = await DBService.queryFirst(db, `
      SELECT ${SELECT_FIELDS}
      FROM messages m
      LEFT JOIN files f ON m.file_id = f.id
      WHERE m.id = ?
    `, [parseInt(id, 10) || 0])
    return result || null
  },

  /**
   * 删除单条消息。
   * 若该消息挂着一个文件，同时删除文件记录，并返回 r2_key 供上层清理磁盘对象。
   * 只删这一条，绝不触碰其它历史。
   */
  async deleteMessage(db, id) {
    const msgId = parseInt(id, 10)
    if (!Number.isFinite(msgId) || msgId <= 0) return { deleted: 0 }

    const row = await DBService.queryFirst(db,
      `SELECT id, file_id FROM messages WHERE id = ?`, [msgId])
    if (!row) return { deleted: 0 }

    let r2Keys = []
    if (row.file_id) {
      const fileRow = await DBService.queryFirst(db,
        `SELECT r2_key FROM files WHERE id = ?`, [row.file_id])
      if (fileRow?.r2_key) r2Keys = [fileRow.r2_key]
    }

    await DBService.execute(db, `DELETE FROM messages WHERE id = ?`, [msgId])

    if (row.file_id) {
      await DBService.execute(db, `DELETE FROM files WHERE id = ?`, [row.file_id])
    }

    return { deleted: 1, id: msgId, fileId: row.file_id || null, r2Keys }
  },

  async deleteAll(db) {
    await DBService.execute(db, `DELETE FROM messages`)
  },

  async countAll(db) {
    const result = await DBService.queryFirst(db, `SELECT COUNT(*) as count FROM messages`)
    return result?.count || 0
  }
}
