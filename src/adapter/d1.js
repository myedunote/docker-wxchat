/**
 * D1 → SQLite 适配器
 *
 * 用 better-sqlite3 复刻 Cloudflare D1 的 PreparedStatement 接口，
 * 使上游 worker/services/database.js 无需任何改动即可运行：
 *
 *   db.prepare(sql)
 *     .bind(...params)
 *     .all()   -> { results: Row[], success: true, meta }
 *     .first() -> Row | null
 *     .run()   -> { success: true, meta: { last_row_id, changes, duration } }
 *   db.batch([stmt, ...]) -> 事务内依次执行，返回结果数组
 *   db.exec(sql)          -> 执行多语句 SQL（用于 schema.sql）
 *
 * 注意：better-sqlite3 是同步的，但 D1 是异步的。这里统一包成 Promise，
 * 保持上游 await 的写法不变。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** 把 better-sqlite3 抛出的错误包装成带 code 的普通 Error，避免上层拿到 SqliteError 细节 */
function wrapError(err, sql) {
  const e = new Error(err?.message || String(err));
  e.code = err?.code || 'SQLITE_ERROR';
  e.sql = sql;
  return e;
}

class D1PreparedStatement {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {string} sql
   * @param {any[]} params
   */
  constructor(db, sql, params = []) {
    this._db = db;
    this._sql = sql;
    this._params = params;
  }

  /** 与 D1 一致：bind 返回新的 statement（不修改自身） */
  bind(...params) {
    return new D1PreparedStatement(this._db, this._sql, params);
  }

  /** 归一化参数：undefined 在 better-sqlite3 会直接抛错，D1 里等同于 NULL */
  _args() {
    return this._params.map((v) => (v === undefined ? null : v));
  }

  async all() {
    try {
      const stmt = this._db.prepare(this._sql);
      const results = stmt.all(...this._args());
      return { results, success: true, meta: { rows_read: results.length } };
    } catch (err) {
      throw wrapError(err, this._sql);
    }
  }

  /**
   * @param {string} [colName] D1 支持取某一列；这里兼容实现
   */
  async first(colName) {
    try {
      const stmt = this._db.prepare(this._sql);
      const row = stmt.get(...this._args());
      if (row === undefined || row === null) return null;
      if (colName) return row[colName] ?? null;
      return row;
    } catch (err) {
      throw wrapError(err, this._sql);
    }
  }

  async run() {
    try {
      const stmt = this._db.prepare(this._sql);
      const started = Date.now();
      const info = stmt.run(...this._args());
      return {
        success: true,
        meta: {
          // better-sqlite3 可能返回 BigInt，统一转成 Number
          last_row_id: Number(info.lastInsertRowid ?? 0),
          changes: Number(info.changes ?? 0),
          duration: Date.now() - started
        }
      };
    } catch (err) {
      throw wrapError(err, this._sql);
    }
  }

  /** D1 的 raw()：返回数组的数组。目前上游未用到，保留以备扩展 */
  async raw() {
    try {
      const stmt = this._db.prepare(this._sql);
      return stmt.raw(true).all(...this._args());
    } catch (err) {
      throw wrapError(err, this._sql);
    }
  }
}

class D1Database {
  /** @param {string} filePath SQLite 文件路径（:memory: 也可） */
  constructor(filePath) {
    this._path = filePath;
    if (filePath !== ':memory:') {
      // mkdir 在目录**已存在**时会静默成功，即使该目录只读。
      // 所以这里只是尽力而为，真正的可写性验证放在
      // src/server.js 的 ensureWritableDir() —— 那是唯一能给出
      // 「进程 uid 是多少、目录属主是谁、该怎么 chown」的地方。
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {
        /* 交给下面的 open 报错，并附带路径上下文 */
      }
    }
    try {
      this._db = new Database(filePath);
    } catch (err) {
      // better-sqlite3 的原始报错是 "unable to open database file"（SQLITE_CANTOPEN），
      // 既看不出是哪个路径，也看不出什么原因，这里补上上下文再抛。
      const e = new Error(
        `无法打开 SQLite 数据库: ${filePath}\n` +
        `  原因  : ${err.code || ''} ${err.message}\n` +
        `  常见原因: 目录不存在 / 目录对当前用户不可写 / 该路径实际是一个目录`
      );
      e.code = err.code || 'SQLITE_CANTOPEN';
      e.cause = err;
      throw e;
    }
    // WAL 提升并发读性能；外键约束与上游 schema 声明保持一致
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');
    this._closed = false;
  }

  prepare(sql) {
    return new D1PreparedStatement(this._db, sql);
  }

  /**
   * D1 batch 语义：所有语句在同一个事务里执行，任一失败全部回滚。
   * 上游 services/database.js 的 batch() 会传入 D1PreparedStatement 实例。
   */
  async batch(statements = []) {
    const list = Array.isArray(statements) ? statements : [];
    const runAll = this._db.transaction(() => {
      const out = [];
      for (const stmt of list) {
        if (!stmt || typeof stmt._sql !== 'string') {
          throw new Error('[D1Adapter] batch() 只接受 prepare() 产出的语句对象');
        }
        const prepared = this._db.prepare(stmt._sql);
        const args = stmt._args();
        // 简单判断：能取到行就用 all，否则用 run
        const isSelect = /^\s*(select|pragma|with)\b/i.test(stmt._sql);
        if (isSelect) {
          const results = prepared.all(...args);
          out.push({ results, success: true, meta: { rows_read: results.length } });
        } else {
          const info = prepared.run(...args);
          out.push({
            success: true,
            meta: {
              last_row_id: Number(info.lastInsertRowid ?? 0),
              changes: Number(info.changes ?? 0)
            }
          });
        }
      }
      return out;
    });
    try {
      return runAll();
    } catch (err) {
      throw wrapError(err, '<batch>');
    }
  }

  /**
   * 执行多语句 SQL（schema.sql 用）。
   * better-sqlite3 的 exec() 天然支持多语句，不需要手工切分。
   */
  exec(sql) {
    try {
      this._db.exec(sql);
      return { count: 0, duration: 0 };
    } catch (err) {
      throw wrapError(err, '<exec>');
    }
  }

  /** 供启动自检使用 */
  async ping() {
    const row = this._db.prepare('SELECT 1 AS ok').get();
    return row?.ok === 1;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      // WAL 模式下把日志合并回主库，保证 volume 里的文件是自洽的
      this._db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* ignore */ }
    this._db.close();
  }
}

export function createD1(filePath) {
  return new D1Database(filePath);
}
