import { DBService } from './database.js'

export const DeviceService = {
  async syncDevice(db, { deviceId, deviceName }) {
    await DBService.execute(db,
      `INSERT INTO devices (id, name, last_active, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = COALESCE(excluded.name, devices.name),
         last_active = datetime('now'),
         updated_at = datetime('now')`,
      [deviceId, deviceName || null]
    )
  },

  async list(db) {
    const result = await DBService.queryAll(db,
      `SELECT id, name, last_active FROM devices ORDER BY last_active DESC`
    )
    return result.results || []
  },

  async deleteAll(db) {
    await DBService.execute(db, `DELETE FROM devices`)
  }
}
