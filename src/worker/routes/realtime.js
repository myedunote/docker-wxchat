import { Hono } from 'hono'
import { MessageService } from '../services/messageService.js'
import { fail } from '../middleware/errorHandler.js'

const realtime = new Hono()

realtime.get('/events', async (c) => {
  const deviceId = c.req.query('deviceId')
  if (!deviceId) {
    return fail(c, { message: '设备ID不能为空', status: 400, code: 'MISSING_DEVICE' })
  }

  try {
    const headers = new Headers({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    let isClosed = false
    let lastId = parseInt(c.req.query('lastMessageId') || '0', 10) || 0

    const sendSSE = (data, event = 'message') => {
      if (isClosed) return
      try {
        const payload = typeof data === 'string' ? data : JSON.stringify(data)
        // 客户端断开后 write 会 reject；Node 下必须显式 catch，否则产生 unhandledRejection
        const p = writer.write(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`))
        if (p && typeof p.catch === 'function') p.catch(() => { /* closed */ })
      } catch { /* closed */ }
    }

    sendSSE({ status: 'connected', deviceId, lastMessageId: lastId }, 'connection')

    // 初始化 lastId
    try {
      const latest = await MessageService.getLatestMessageId(c.env.DB)
      if (!lastId) lastId = latest || 0
    } catch { /* ignore */ }

    const heartbeatTimer = setInterval(() => {
      sendSSE({ t: Date.now() }, 'heartbeat')
    }, 15000)

    const messageCheckTimer = setInterval(async () => {
      if (isClosed) return
      try {
        const { DB } = c.env
        if (!DB) return
        const rows = await MessageService.getMessagesSince(DB, lastId, 50)
        if (rows.length > 0) {
          lastId = rows[rows.length - 1].id
          sendSSE({
            newMessages: rows.length,
            lastMessageId: lastId,
            messages: rows
          }, 'message')
        }
      } catch { /* silent */ }
    }, 2000)

    const cleanup = () => {
      if (isClosed) return
      isClosed = true
      clearInterval(heartbeatTimer)
      clearInterval(messageCheckTimer)
      try { writer.close() } catch { /* ignore */ }
    }

    const timeout = setTimeout(() => {
      sendSSE({ reason: 'timeout', reconnect: true, lastMessageId: lastId }, 'timeout')
      cleanup()
    }, 25000)

    c.req.raw.signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      cleanup()
    })

    return new Response(readable, { headers })
  } catch (error) {
    console.error('[Realtime] SSE失败:', error)
    return fail(c, error)
  }
})

realtime.get('/poll', async (c) => {
  try {
    const { DB } = c.env
    const deviceId = c.req.query('deviceId')
    const lastMessageId = c.req.query('lastMessageId') || '0'
    const timeout = Math.min(parseInt(c.req.query('timeout') || '25', 10), 25)

    if (!deviceId) {
      return fail(c, { message: '设备ID不能为空', status: 400, code: 'MISSING_DEVICE' })
    }
    if (!DB) {
      return fail(c, { message: '数据库未绑定', status: 500, code: 'DB_UNBOUND' })
    }

    const start = Date.now()
    const maxWait = timeout * 1000

    while (Date.now() - start < maxWait) {
      const rows = await MessageService.getMessagesSince(DB, lastMessageId, 50)
      if (rows.length > 0) {
        return c.json({
          success: true,
          hasNewMessages: true,
          newMessageCount: rows.length,
          lastMessageId: rows[rows.length - 1].id,
          messages: rows,
          timestamp: new Date().toISOString()
        })
      }
      await new Promise((r) => setTimeout(r, 1500))
    }

    return c.json({
      success: true,
      hasNewMessages: false,
      newMessageCount: 0,
      lastMessageId: parseInt(lastMessageId, 10) || 0,
      messages: [],
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('[Realtime] 长轮询失败:', error)
    return fail(c, error)
  }
})

export default realtime
