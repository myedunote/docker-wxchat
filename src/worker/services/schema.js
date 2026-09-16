/**
 * D1 schema 自动迁移（幂等）
 * 旧库缺 status/meta、type 约束过窄时，在线补齐，避免 500
 */
import { DBService } from './database.js'

let ensurePromise = null

function colNames(pragmaRows) {
  return new Set((pragmaRows || []).map((r) => r.name))
}

async function tableCreateSql(db, table) {
  const row = await DBService.queryFirst(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  )
  return row?.sql || ''
}

async function ensureLoginAttempts(db) {
  await DBService.execute(db, `
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

async function ensureDevices(db) {
  await DBService.execute(db, `
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      last_active TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  await DBService.batch(db, [
    { sql: `INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)`, params: ['web-default', 'Web浏览器'] },
    { sql: `INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)`, params: ['mobile-default', '移动设备'] },
    { sql: `INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)`, params: ['ai-system', 'AI助手'] }
  ])
}

async function ensureFiles(db) {
  await DBService.execute(db, `
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      r2_key TEXT NOT NULL UNIQUE,
      upload_device_id TEXT NOT NULL,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

/**
 * 重建 messages，放宽 type / 补齐 status+meta
 * 只在检测到旧 CHECK 或不完整结构时调用
 */
async function rebuildMessagesTable(db, names) {
  console.log('[Schema] rebuilding messages table for v2…')
  // 上次半截迁移残留
  try {
    await DBService.execute(db, `DROP TABLE IF EXISTS messages_v2_new`)
  } catch (_) { /* ignore */ }

  await DBService.execute(db, `
    CREATE TABLE messages_v2_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('text', 'file', 'system', 'ai')),
      content TEXT,
      file_id INTEGER,
      device_id TEXT NOT NULL,
      meta TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'failed')),
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
    )
  `)

  // 按现有列动态拼 SELECT，避免引用不存在的列
  const typeExpr = names.has('type')
    ? `CASE WHEN type IN ('text','file','system','ai') THEN type ELSE 'text' END`
    : `'text'`
  const contentExpr = names.has('content') ? 'content' : 'NULL'
  const fileIdExpr = names.has('file_id') ? 'file_id' : 'NULL'
  const deviceExpr = names.has('device_id') ? 'device_id' : `'web-default'`
  const metaExpr = names.has('meta') ? 'meta' : 'NULL'
  const statusExpr = names.has('status')
    ? `CASE WHEN status IN ('sending','sent','failed') THEN status ELSE 'sent' END`
    : `'sent'`
  const tsExpr = names.has('timestamp') ? `COALESCE(timestamp, datetime('now'))` : `datetime('now')`
  const createdExpr = names.has('created_at') ? `COALESCE(created_at, datetime('now'))` : `datetime('now')`
  const updatedExpr = names.has('updated_at') ? `COALESCE(updated_at, datetime('now'))` : `datetime('now')`
  const idExpr = names.has('id') ? 'id' : 'NULL'

  await DBService.execute(db, `
    INSERT INTO messages_v2_new (
      id, type, content, file_id, device_id, meta, status, timestamp, created_at, updated_at
    )
    SELECT
      ${idExpr},
      ${typeExpr},
      ${contentExpr},
      ${fileIdExpr},
      ${deviceExpr},
      ${metaExpr},
      ${statusExpr},
      ${tsExpr},
      ${createdExpr},
      ${updatedExpr}
    FROM messages
  `)

  await DBService.execute(db, `DROP TABLE messages`)
  await DBService.execute(db, `ALTER TABLE messages_v2_new RENAME TO messages`)

  await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`)
  await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id DESC)`)
  await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id)`)
  await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type)`)
  console.log('[Schema] messages rebuild done')
}

async function ensureMessages(db) {
  const info = await DBService.queryAll(db, `PRAGMA table_info(messages)`)
  const names = colNames(info.results)

  if (!names.size) {
    await DBService.execute(db, `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('text', 'file', 'system', 'ai')),
        content TEXT,
        file_id INTEGER,
        device_id TEXT NOT NULL,
        meta TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'failed')),
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
      )
    `)
    await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`)
    await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id DESC)`)
    await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id)`)
    await DBService.execute(db, `CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type)`)
    return
  }

  const createSql = await tableCreateSql(db, 'messages')
  const typeConstraintOld =
    /\(\s*'text'\s*,\s*'file'\s*\)/.test(createSql) &&
    !/'ai'/.test(createSql)
  const missingStatus = !names.has('status')
  const missingMeta = !names.has('meta')

  // type 约束过窄 → 必须重建（ALTER 改不了 CHECK）
  if (typeConstraintOld) {
    await rebuildMessagesTable(db, names)
    return
  }

  // 只缺列：轻量 ALTER（D1/SQLite 支持 ADD COLUMN）
  if (missingStatus) {
    try {
      await DBService.execute(db,
        `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`)
      console.log('[Schema] added messages.status')
    } catch (e) {
      console.warn('[Schema] add status failed, fallback rebuild', e.message)
      await rebuildMessagesTable(db, names)
      return
    }
  }
  if (missingMeta) {
    try {
      await DBService.execute(db,
        `ALTER TABLE messages ADD COLUMN meta TEXT DEFAULT NULL`)
      console.log('[Schema] added messages.meta')
    } catch (e) {
      console.warn('[Schema] add meta failed, fallback rebuild', e.message)
      const info2 = await DBService.queryAll(db, `PRAGMA table_info(messages)`)
      await rebuildMessagesTable(db, colNames(info2.results))
    }
  }
}

async function runEnsureSchema(db) {
  if (!db) return { ok: false, reason: 'no-db' }
  await ensureFiles(db)
  await ensureDevices(db)
  await ensureLoginAttempts(db)
  await ensureMessages(db)
  return { ok: true }
}

/**
 * 全局只跑一次（同 isolate 内）；失败允许下次请求重试
 */
export function ensureSchema(db) {
  if (!ensurePromise) {
    ensurePromise = runEnsureSchema(db)
      .catch((e) => {
        console.error('[Schema] ensure failed', e)
        ensurePromise = null
        throw e
      })
  }
  return ensurePromise
}
