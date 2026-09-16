/**
 * 统一错误处理与参数校验
 */

export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message)
    this.status = status
    this.code = code
    this.name = 'AppError'
  }
}

export function validateParams(obj, required = []) {
  for (const key of required) {
    const val = obj[key]
    if (val === undefined || val === null || val === '') {
      throw new AppError(`缺少必要参数: ${key}`, 400, 'MISSING_PARAM')
    }
  }
}

export function ok(c, data = null, extra = {}) {
  return c.json({ success: true, data, ...extra })
}

export function fail(c, error, status = 500) {
  const message = typeof error === 'string' ? error : (error?.message || '服务器错误')
  const code = error?.code || 'INTERNAL_ERROR'
  const httpStatus = error?.status || status
  return c.json({ success: false, error: message, code }, httpStatus)
}

export function errorHandler(err, c) {
  console.error('[Error]', err?.stack || err)
  if (err instanceof AppError) {
    return fail(c, err, err.status)
  }
  const expose = c.env?.ENVIRONMENT !== 'production'
  return c.json({
    success: false,
    error: expose ? (err?.message || '服务器错误') : '服务器错误',
    code: 'INTERNAL_ERROR'
  }, 500)
}

export function notFoundHandler(c) {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ success: false, error: '接口不存在', code: 'NOT_FOUND' }, 404)
  }
  return c.text('Not Found', 404)
}
