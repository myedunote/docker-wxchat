/**
 * 鉴权：密码登录 + JWT + 登录限流
 */
import { Hono } from 'hono'
import { AppError, ok, fail, validateParams } from './middleware/errorHandler.js'
import { DBService } from './services/database.js'

function base64urlEncode(bytesOrStr) {
  const str = typeof bytesOrStr === 'string'
    ? btoa(unescape(encodeURIComponent(bytesOrStr)))
    : btoa(String.fromCharCode(...new Uint8Array(bytesOrStr)))
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64urlDecodeToString(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return decodeURIComponent(escape(atob(padded + pad)))
}

export const AuthUtils = {
  async generateToken(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' }
    const encodedHeader = base64urlEncode(JSON.stringify(header))
    const encodedPayload = base64urlEncode(JSON.stringify(payload))
    const signature = await this.sign(`${encodedHeader}.${encodedPayload}`, secret)
    return `${encodedHeader}.${encodedPayload}.${signature}`
  },

  async verifyToken(token, secret) {
    try {
      if (!token || typeof token !== 'string') return null
      const parts = token.split('.')
      if (parts.length !== 3) return null
      const [header, payload, signature] = parts
      const expected = await this.sign(`${header}.${payload}`, secret)
      if (signature !== expected) return null
      const decoded = JSON.parse(base64urlDecodeToString(payload))
      if (decoded.exp && Date.now() > decoded.exp) return null
      return decoded
    } catch {
      return null
    }
  },

  async sign(data, secret) {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
    return base64urlEncode(new Uint8Array(signature))
  }
}

function clientIp(c) {
  return c.req.header('cf-connecting-ip')
    || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
}

async function checkLoginLock(db, ip, maxAttempts, lockMinutes) {
  if (!db) return { locked: false }
  try {
    const row = await DBService.queryFirst(db,
      `SELECT fail_count, locked_until FROM login_attempts WHERE ip = ?`, [ip])
    if (!row) return { locked: false, failCount: 0 }
    if (row.locked_until) {
      const lockedUntil = Date.parse(row.locked_until + 'Z') || Date.parse(row.locked_until)
      if (lockedUntil && Date.now() < lockedUntil) {
        return {
          locked: true,
          failCount: row.fail_count,
          retryAfterMs: lockedUntil - Date.now()
        }
      }
    }
    return { locked: false, failCount: row.fail_count || 0 }
  } catch {
    // 表可能未初始化，不阻断登录
    return { locked: false, failCount: 0 }
  }
}

async function recordLoginFailure(db, ip, maxAttempts, lockMinutes) {
  if (!db) return
  try {
    const row = await DBService.queryFirst(db,
      `SELECT fail_count FROM login_attempts WHERE ip = ?`, [ip])
    const next = (row?.fail_count || 0) + 1
    const lockedUntil = next >= maxAttempts
      ? new Date(Date.now() + lockMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : null
    await DBService.execute(db,
      `INSERT INTO login_attempts (ip, fail_count, locked_until, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(ip) DO UPDATE SET
         fail_count = ?,
         locked_until = ?,
         updated_at = datetime('now')`,
      [ip, next, lockedUntil, next, lockedUntil]
    )
  } catch (e) {
    console.warn('[Auth] 记录登录失败失败:', e.message)
  }
}

async function clearLoginFailures(db, ip) {
  if (!db) return
  try {
    await DBService.execute(db, `DELETE FROM login_attempts WHERE ip = ?`, [ip])
  } catch { /* ignore */ }
}

/**
 * 生成「登录失败」的排查提示。
 *
 * 抽成纯函数是为了让自检能直接断言它 —— 这段文案是用户排查配置问题时唯一能
 * 拿到的线索。它一旦退化（比如被改回只回一句「密码错误」），用户就重新回到
 * 「完全靠猜」的状态，而这正是本函数存在的理由。
 *
 * 两类成因都表现为「长度不一致」：
 *   1. .env 里的密码被 compose 改写（未加引号时 $ 会被插值、` #` 会被截断）
 *   2. 改了 .env 却没重建容器（只 `restart` 不会重新读取 env_file）
 * 长度一致却对不上，则更可能是大小写/空格/旧密码这类人为因素。
 *
 * ⚠ 长度信息只写服务端日志，绝不出现在 HTTP 响应里 ——
 *   那会把密码长度泄露给任何能访问登录接口的人。
 */
export function describeLoginFailure(submitted, expected) {
  if (submitted.length !== expected.length) {
    return `提交长度 ${submitted.length} ≠ 期望长度 ${expected.length}，` +
      '多半是 .env 里的密码被 compose 改写或容器未重建（跑 npm run check:env 核对）'
  }
  return '长度一致但内容不同，请检查大小写、首尾空格，或是否仍在用旧密码'
}

export const authMiddleware = async (c, next) => {  const path = c.req.path
  if (path.startsWith('/api/auth/')) {
    return next()
  }

  let token = null
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else {
    token = c.req.query('token') || null
  }

  if (!token) {
    return c.json({ success: false, error: '未授权访问', code: 'UNAUTHORIZED' }, 401)
  }

  const payload = await AuthUtils.verifyToken(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ success: false, error: 'Token无效或已过期', code: 'TOKEN_INVALID' }, 401)
  }

  c.set('user', payload)
  return next()
}

export const authRoutes = new Hono()

authRoutes.post('/login', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { password } = body
    validateParams({ password }, ['password'])

    const ip = clientIp(c)
    const maxAttempts = parseInt(c.env.MAX_LOGIN_ATTEMPTS || '5', 10)
    const lockMinutes = parseInt(c.env.LOGIN_LOCKOUT_MINUTES || '15', 10)
    const lock = await checkLoginLock(c.env.DB, ip, maxAttempts, lockMinutes)
    if (lock.locked) {
      const mins = Math.ceil((lock.retryAfterMs || 0) / 60000)
      return fail(c, new AppError(`登录失败次数过多，请 ${mins} 分钟后再试`, 429, 'LOGIN_LOCKED'))
    }

    const expected = c.env.ACCESS_PASSWORD
    if (!expected) {
      return fail(c, new AppError('服务端未配置访问密码', 500, 'CONFIG_ERROR'))
    }

    if (password !== expected) {
      await recordLoginFailure(c.env.DB, ip, maxAttempts, lockMinutes)
      // 只回一句「密码错误」时，用户无法区分「密码被 compose 改写了」和
      // 「改了 .env 但没重建容器」—— 这两种情况的处置方式完全不同。
      // 这里把长度对账写进服务端日志，让两者一眼可分。
      console.warn(`[Auth] 登录失败 ip=${ip} —— ${describeLoginFailure(password, expected)}`)
      return fail(c, new AppError('密码错误', 401, 'BAD_PASSWORD'))
    }

    await clearLoginFailures(c.env.DB, ip)

    const expireHours = parseInt(c.env.SESSION_EXPIRE_HOURS || '24', 10)
    const payload = {
      iat: Date.now(),
      exp: Date.now() + expireHours * 60 * 60 * 1000,
      type: 'access'
    }
    const token = await AuthUtils.generateToken(payload, c.env.JWT_SECRET)

    return ok(c, {
      token,
      expiresIn: expireHours * 60 * 60
    })
  } catch (error) {
    return fail(c, error)
  }
})

authRoutes.get('/verify', async (c) => {
  try {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ valid: false, message: '缺少认证信息' }, 401)
    }
    const token = authHeader.slice(7)
    const payload = await AuthUtils.verifyToken(token, c.env.JWT_SECRET)
    if (!payload) {
      return c.json({ valid: false, message: 'Token无效或已过期' }, 401)
    }
    return c.json({ valid: true, payload })
  } catch (error) {
    return c.json({ valid: false, message: '服务器错误' }, 500)
  }
})

authRoutes.post('/logout', async (c) => {
  return ok(c, { message: '已登出' })
})
