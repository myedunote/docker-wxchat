/**
 * AI / 生图服务端代理 —— 密钥永不下发前端
 */
import { Hono } from 'hono'
import { MessageService } from '../services/messageService.js'
import { FileService } from '../services/fileService.js'
import { validateParams, ok, fail, AppError } from '../middleware/errorHandler.js'

const ai = new Hono()

function parseBool(v, d = false) {
  if (v === undefined || v === null || v === '') return d
  return String(v).toLowerCase() === 'true' || v === '1'
}

ai.get('/config', async (c) => {
  return ok(c, {
    aiEnabled: parseBool(c.env.AI_ENABLED, true) && !!c.env.AI_API_KEY,
    // 注意：这里的判断必须与下面 /image 路由实际使用的密钥保持一致。
    // /image 用的是 `IMAGE_GEN_API_KEY || AI_API_KEY`（生图可复用对话密钥），
    // 所以这里也要回落，否则「只配了 AI_API_KEY」时前端会以为生图不可用，
    // 而后端其实是能跑的 —— 上游原本漏了这层回落。
    imageGenEnabled:
      parseBool(c.env.IMAGE_GEN_ENABLED, true) &&
      !!(c.env.IMAGE_GEN_API_KEY || c.env.AI_API_KEY),
    aiModel: c.env.AI_MODEL || 'deepseek-ai/DeepSeek-R1',
    imageModel: c.env.IMAGE_GEN_MODEL || 'Kwai-Kolors/Kolors',
    defaultSize: c.env.IMAGE_GEN_DEFAULT_SIZE || '1024x1024'
  })
})

// 流式聊天代理
ai.post('/chat', async (c) => {
  try {
    if (!parseBool(c.env.AI_ENABLED, true)) {
      throw new AppError('AI 功能未启用', 403, 'AI_DISABLED')
    }
    const apiKey = c.env.AI_API_KEY
    if (!apiKey) throw new AppError('服务端未配置 AI_API_KEY', 500, 'AI_KEY_MISSING')

    const body = await c.req.json()
    const { messages, content, deviceId } = body
    let chatMessages = messages
    if (!chatMessages && content) {
      chatMessages = [{ role: 'user', content: String(content) }]
    }
    if (!Array.isArray(chatMessages) || chatMessages.length === 0) {
      throw new AppError('消息不能为空', 400, 'EMPTY_MESSAGES')
    }

    const baseUrl = (c.env.AI_API_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
    const model = c.env.AI_MODEL || 'deepseek-ai/DeepSeek-R1'
    const maxTokens = parseInt(c.env.AI_MAX_TOKENS || '4000', 10)
    const temperature = parseFloat(c.env.AI_TEMPERATURE || '0.7')

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: chatMessages,
        max_tokens: maxTokens,
        temperature,
        stream: true
      })
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      console.error('[AI] upstream error', upstream.status, errText)
      throw new AppError(`AI 服务错误: ${upstream.status}`, 502, 'AI_UPSTREAM_ERROR')
    }

    // 透传 SSE 流
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      }
    })
  } catch (error) {
    console.error('[AI] chat 失败:', error)
    return fail(c, error)
  }
})

// 非流式 + 自动落库
ai.post('/message', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { content, deviceId, type = 'ai_response' } = body
    validateParams({ content, deviceId }, ['content', 'deviceId'])
    const result = await MessageService.createAIMessage(DB, { content, deviceId, type })
    return ok(c, result)
  } catch (error) {
    return fail(c, error)
  }
})

// 生图代理
ai.post('/image', async (c) => {
  try {
    if (!parseBool(c.env.IMAGE_GEN_ENABLED, true)) {
      throw new AppError('AI 绘画未启用', 403, 'IMAGE_GEN_DISABLED')
    }
    const apiKey = c.env.IMAGE_GEN_API_KEY || c.env.AI_API_KEY
    if (!apiKey) throw new AppError('服务端未配置 IMAGE_GEN_API_KEY', 500, 'IMAGE_KEY_MISSING')

    const body = await c.req.json()
    const prompt = (body.prompt || '').trim()
    if (!prompt) throw new AppError('请输入图片描述', 400, 'EMPTY_PROMPT')
    if (prompt.length > 1000) throw new AppError('图片描述过长', 400, 'PROMPT_TOO_LONG')

    // base URL 与 apiKey 一样支持「生图独立配置，留空回落对话配置」。
    // IMAGE_GEN_BASE_URL 在 src/adapter/env.js 里已被读取并归一化，
    // 但这里曾经漏了回落 —— 结果是用户把生图指向另一家服务商时被静默忽略，
    // 请求照样发到 AI_API_BASE_URL。与上面的 IMAGE_GEN_API_KEY 保持同一套回落语义。
    const baseUrl = (
      c.env.IMAGE_GEN_BASE_URL || c.env.AI_API_BASE_URL || 'https://api.siliconflow.cn/v1'
    ).replace(/\/$/, '')
    const model = c.env.IMAGE_GEN_MODEL || 'Kwai-Kolors/Kolors'
    const size = body.size || c.env.IMAGE_GEN_DEFAULT_SIZE || '1024x1024'
    const steps = Math.min(Math.max(parseInt(body.steps || '20', 10), 1), 50)
    const guidance = Math.min(Math.max(parseFloat(body.guidance || '7.5'), 1), 20)

    const upstream = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        prompt,
        negative_prompt: body.negative_prompt || body.negativePrompt || undefined,
        image_size: size,
        num_inference_steps: steps,
        guidance_scale: guidance,
        batch_size: 1
      })
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      console.error('[AI] image upstream error', upstream.status, errText)
      throw new AppError(`生图服务错误: ${upstream.status}`, 502, 'IMAGE_UPSTREAM_ERROR')
    }

    const data = await upstream.json()
    // 统一返回
    const images = data.images || data.data || []
    return ok(c, { images, raw: data })
  } catch (error) {
    console.error('[AI] image 失败:', error)
    return fail(c, error)
  }
})

// 生图后下载并保存到 R2 + 消息
ai.post('/image/save', async (c) => {
  try {
    const { DB, R2 } = c.env
    const body = await c.req.json()
    const { imageUrl, deviceId, prompt } = body
    validateParams({ imageUrl, deviceId }, ['imageUrl', 'deviceId'])

    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new AppError('图片下载失败', 502, 'IMAGE_DOWNLOAD_FAILED')
    const contentType = imgRes.headers.get('content-type') || 'image/png'
    const buf = await imgRes.arrayBuffer()
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
      : contentType.includes('webp') ? 'webp' : 'png'
    const fileName = `ai-${Date.now()}.${ext}`
    const r2Key = FileService.generateR2Key(fileName)

    await FileService.uploadToR2(R2, r2Key, buf, { contentType, fileName })
    const fileRecord = await FileService.saveFileRecord(DB, {
      fileName: prompt ? `AI-${prompt.slice(0, 30)}.${ext}` : fileName,
      r2Key,
      fileSize: buf.byteLength,
      mimeType: contentType,
      deviceId
    })
    await MessageService.createFileMessage(DB, fileRecord.id, deviceId)

    return ok(c, {
      fileId: fileRecord.id,
      r2Key,
      fileName: fileRecord.fileName || fileName,
      fileSize: buf.byteLength
    })
  } catch (error) {
    console.error('[AI] image save 失败:', error)
    return fail(c, error)
  }
})

export default ai
