/**
 * wxchat Worker 入口 v2
 * Hono + D1 + R2 + Assets
 *
 * Docker 自托管说明：
 * 本文件与上游 xiyewuqiu/wxchat 的 worker/index.js 保持同构，
 * D1 / R2 / ASSETS 三个 Cloudflare 绑定由 src/adapter/ 提供同形实现。
 * 唯一新增的是 GET /api/config（供前端读取运行时可配置项）。
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes, authMiddleware } from './auth.js'
import messagesRoutes from './routes/messages.js'
import filesRoutes from './routes/files.js'
import searchRoutes from './routes/search.js'
import syncRoutes from './routes/sync.js'
import realtimeRoutes from './routes/realtime.js'
import aiRoutes from './routes/ai.js'
import configRoutes from './routes/config.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { ensureSchema } from './services/schema.js'

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Disposition']
}))

// 任何 API 进来先幂等修库（旧 D1 缺 status/meta 直接 500 的锅）
app.use('/api/*', async (c, next) => {
  if (c.env.DB) {
    await ensureSchema(c.env.DB)
  }
  return next()
})

// 健康检查（无需鉴权）
app.get('/api/health', async (c) => {
  let schema = 'unknown'
  try {
    if (c.env.DB) {
      await ensureSchema(c.env.DB)
      schema = 'ready'
    } else {
      schema = 'no-db'
    }
  } catch (e) {
    schema = `error:${e.message || e}`
  }
  return c.json({
    success: true,
    data: {
      status: 'ok',
      version: '2.0.1',
      schema,
      time: new Date().toISOString()
    }
  })
})

// 鉴权路由
app.route('/api/auth', authRoutes)

// API 鉴权
app.use('/api/*', authMiddleware)

// 业务路由
app.route('/api/messages', messagesRoutes)
app.route('/api/files', filesRoutes)
app.route('/api/search', searchRoutes)
app.route('/api/ai', aiRoutes)
app.route('/api', configRoutes)
app.route('/api', syncRoutes)
app.route('/api', realtimeRoutes)

app.onError(errorHandler)
app.notFound(notFoundHandler)

// 静态资源：优先 ASSETS binding，兼容 fallback
app.get('*', async (c) => {
  const url = new URL(c.req.url)

  /**
   * /api/* 不参与 SPA fallback。
   * 上游这里会把「不存在的 API 路径」也回落成 index.html（HTTP 200 + HTML），
   * 前端解析 JSON 时拿到 HTML 会报出难以定位的错误。这里显式返回 JSON 404。
   */
  if (url.pathname.startsWith('/api/')) {
    return c.json({ success: false, error: '接口不存在', code: 'NOT_FOUND' }, 404)
  }

  // 未登录访问业务页时，前端自行跳转；这里只做资源托管
  if (c.env.ASSETS) {
    try {
      return await c.env.ASSETS.fetch(c.req.raw)
    } catch (e) {
      // SPA fallback
      try {
        const indexReq = new Request(new URL('/index.html', url.origin), c.req.raw)
        return await c.env.ASSETS.fetch(indexReq)
      } catch {
        return c.text('Not Found', 404)
      }
    }
  }

  return c.text('ASSETS binding missing', 500)
})

/**
 * 返回 Hono 应用实例。
 * src/server.js 通过 createApp() 拿到 app，再用 app.fetch(request, env, ctx) 驱动。
 */
export function createApp() {
  return app
}

export default app
