/**
 * 运行时可配置项下发（Docker 版新增）
 *
 * 前端需要知道「服务端怎么配的」才能做出正确交互：
 *   - 最大上传体积是多少（而不是前端硬编码 50MB）
 *   - 一次加载多少条消息
 *   - 清空数据是否需要额外输入确认码
 *   - AI / 绘画是否真的可用（配了 key 才算可用）
 *
 * 这里只回传开关与限额，绝不回传任何密钥。
 */
import { Hono } from 'hono'
import { ok, fail } from '../middleware/errorHandler.js'

const config = new Hono()

function parseBool(v, d = false) {
  if (v === undefined || v === null || v === '') return d
  const s = String(v).toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

function toInt(v, d) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

config.get('/config', async (c) => {
  try {
    const env = c.env

    const maxFileSize = toInt(env.MAX_FILE_SIZE, 0)
    const loadDefault = toInt(env.MESSAGE_LOAD_DEFAULT, 5000) || 5000
    const loadMax = toInt(env.MESSAGE_LOAD_MAX, 100000) || 100000

    return ok(c, {
      version: '2.0.1',

      // 上传限制：0 = 不限制
      maxFileSize,
      maxFileSizeText: maxFileSize > 0 ? `${Math.round(maxFileSize / 1024 / 1024)}MB` : '不限制',

      // 消息分页
      messageLoadDefault: Math.min(loadDefault, loadMax),
      messageLoadMax: loadMax,

      // 清空数据：需要确认码时前端会多弹一层输入
      clearConfirmRequired: !!env.CLEAR_CONFIRM_CODE,

      // AI 能力：必须「开关打开」且「服务端有 key」才算真正可用
      aiEnabled: parseBool(env.AI_ENABLED, true) && !!env.AI_API_KEY,
      imageGenEnabled: parseBool(env.IMAGE_GEN_ENABLED, true) && !!(env.IMAGE_GEN_API_KEY || env.AI_API_KEY),

      // 仅供界面展示，不含密钥
      aiModel: env.AI_MODEL || 'deepseek-ai/DeepSeek-R1',
      imageModel: env.IMAGE_GEN_MODEL || 'Kwai-Kolors/Kolors',

      timezone: env.TZ || 'Asia/Shanghai'
    })
  } catch (error) {
    return fail(c, error)
  }
})

export default config
