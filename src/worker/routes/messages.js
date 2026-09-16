import { Hono } from 'hono'
import { MessageService } from '../services/messageService.js'
import { FileService } from '../services/fileService.js'
import { validateParams, ok, fail } from '../middleware/errorHandler.js'

const messages = new Hono()

messages.get('/', async (c) => {
  try {
    const { DB } = c.env
    // 默认单页条数由 MESSAGE_LOAD_DEFAULT 决定（Docker 版默认 5000，上游为 50）
    const limit = c.req.query('limit') || String(MessageService.loadDefault())
    const offset = c.req.query('offset') || '0'
    const beforeId = c.req.query('beforeId') || null
    const afterId = c.req.query('afterId') || null

    const result = await MessageService.getMessages(DB, { limit, offset, beforeId, afterId })
    return c.json({
      success: true,
      data: result.data,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    })
  } catch (error) {
    console.error('[Messages] 获取失败:', error)
    return fail(c, error)
  }
})

messages.post('/', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { content, deviceId, type = 'text' } = body
    validateParams({ content, deviceId }, ['content', 'deviceId'])

    if (typeof content !== 'string' || !content.trim()) {
      return fail(c, { message: '消息内容不能为空', status: 400, code: 'EMPTY_CONTENT' })
    }
    if (content.length > 20000) {
      return fail(c, { message: '消息过长', status: 400, code: 'CONTENT_TOO_LONG' })
    }

    const allowed = ['text', 'system']
    const msgType = allowed.includes(type) ? type : 'text'
    const result = await MessageService.createMessage(DB, {
      type: msgType,
      content: content.trim(),
      deviceId
    })
    return ok(c, { id: result.id })
  } catch (error) {
    return fail(c, error)
  }
})

/**
 * 删除单条消息（Docker 版新增，对应前端「删除」操作）
 * DELETE /api/messages/:id
 * 若消息关联文件，则连文件记录与磁盘对象一并清理，且只影响这一条。
 */
messages.delete('/:id', async (c) => {
  try {
    const { DB, R2 } = c.env
    const id = c.req.param('id')

    if (!/^\d+$/.test(String(id))) {
      return fail(c, { message: '消息 ID 非法', status: 400, code: 'BAD_MESSAGE_ID' })
    }

    const result = await MessageService.deleteMessage(DB, id)
    if (!result.deleted) {
      return fail(c, { message: '消息不存在', status: 404, code: 'MESSAGE_NOT_FOUND' })
    }

    // 磁盘对象删除失败不影响接口成功（记录已删除，残留文件由运维清理）
    for (const key of result.r2Keys || []) {
      try {
        await FileService.deleteFromR2(R2, key)
      } catch (e) {
        console.warn('[Messages] 删除磁盘文件失败:', key, e?.message || e)
      }
    }

    return ok(c, { id: result.id, fileId: result.fileId })
  } catch (error) {
    console.error('[Messages] 删除失败:', error)
    return fail(c, error)
  }
})

export default messages
