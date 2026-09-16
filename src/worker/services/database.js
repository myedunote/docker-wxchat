/**
 * D1 数据库封装
 */

export const DBService = {
  async queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql)
    return params.length ? stmt.bind(...params).all() : stmt.all()
  },

  async queryFirst(db, sql, params = []) {
    const stmt = db.prepare(sql)
    return params.length ? stmt.bind(...params).first() : stmt.first()
  },

  async execute(db, sql, params = []) {
    const stmt = db.prepare(sql)
    return params.length ? stmt.bind(...params).run() : stmt.run()
  },

  /** 真批量事务 */
  async batch(db, statements) {
    // statements: Array<{ sql, params? }>
    const prepared = statements.map(({ sql, params = [] }) => {
      const stmt = db.prepare(sql)
      return params.length ? stmt.bind(...params) : stmt
    })
    return db.batch(prepared)
  }
}
