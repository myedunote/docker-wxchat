import { Hono } from 'hono'
import { MessageService } from '../services/messageService.js'
import { FileService } from '../services/fileService.js'
import { DeviceService } from '../services/deviceService.js'
import { validateParams, ok, fail, AppError } from '../middleware/errorHandler.js'

const sync = new Hono()

// 设备同步
sync.post('/sync', async (c) => {
  try {
    const { DB } = c.env
    const { deviceId, deviceName } = await c.req.json()
    validateParams({ deviceId }, ['deviceId'])
    await DeviceService.syncDevice(DB, { deviceId, deviceName })
    return ok(c, { message: '设备同步成功' })
  } catch (error) {
    return fail(c, error)
  }
})

// 兼容旧路径 /api/sync/clear-all 与新路径 /api/clear-all
async function handleClearAll(c) {
  try {
    const { DB, R2 } = c.env
    const body = await c.req.json().catch(() => ({}))
    const confirmCode = body.confirmCode

    /**
     * Docker 版语义调整：
     *   - CLEAR_CONFIRM_CODE 为空（默认）=> 不再要求输入确认码，
     *     前端用「滑动确认」作为唯一防误触手段；
     *   - CLEAR_CONFIRM_CODE 有值      => 作为可选的二次确认保留，必须匹配。
     * 上游默认值是写死的 '1234'，自托管场景下这既是无用摩擦也是弱口令。
     */
    const expected = c.env.CLEAR_CONFIRM_CODE
    if (expected) {
      if (String(confirmCode ?? '') !== String(expected)) {
        throw new AppError('确认码错误', 400, 'BAD_CONFIRM_CODE')
      }
    }

    const messageCount = await MessageService.countAll(DB)
    const fileStats = await FileService.getStats(DB)
    const r2Keys = await FileService.getAllR2Keys(DB)

    let deletedR2Files = 0
    for (const key of r2Keys) {
      if (await FileService.deleteFromR2(R2, key)) deletedR2Files++
    }

    await MessageService.deleteAll(DB)
    await FileService.deleteAll(DB)
    // 设备表保留，仅清活跃可选；产品语义是清聊天数据，保留设备
    // await DeviceService.deleteAll(DB)

    return ok(c, {
      deletedMessages: messageCount,
      deletedFiles: fileStats?.count || 0,
      deletedFileSize: fileStats?.totalSize || 0,
      deletedR2Files,
      message: '所有数据已成功清理'
    })
  } catch (error) {
    console.error('[Sync] 清理失败:', error)
    return fail(c, error)
  }
}

sync.post('/clear-all', handleClearAll)
sync.post('/sync/clear-all', handleClearAll)

// AI 消息落库
sync.post('/ai/message', async (c) => {
  try {
    const { DB } = c.env
    const { content, deviceId, type = 'ai_response' } = await c.req.json()
    validateParams({ content, deviceId }, ['content', 'deviceId'])
    const result = await MessageService.createAIMessage(DB, { content, deviceId, type })
    return ok(c, result)
  } catch (error) {
    return fail(c, error)
  }
})

export default sync
