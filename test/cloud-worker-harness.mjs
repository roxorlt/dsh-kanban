// 测试共享工具：Cloudflare Worker 的内存 D1 兼容层与调用助手（C2/C3 共用）。
//
// 设计：**不 mock SQL** —— 用 node:sqlite 的内存库实现 D1 的 prepare/bind/all/first/run/batch，
// 在构造时执行真实的 cloudflare/migrations/0001_kanban_sync.sql，因此同时验证 Worker 路由、
// 写入 SQL 的可执行性、迁移幂等性，以及入站队列的租约/退避/零丢失回放语义。
// C3 的端到端测试复用同一套内存 D1，避免两套「假云端」行为漂移。
//
// Node < 22.13 没有 node:sqlite：`HAS_SQLITE` 为 false，依赖该能力的测试文件应整体 skip。
import { readFileSync } from 'node:fs'
import { handleRequest } from '../cloudflare/worker.mjs'

let DatabaseSync = null
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

/** 当前 Node 是否支持 node:sqlite（决定依赖内存 D1 的用例是否可跑）。 */
export const HAS_SQLITE = DatabaseSync !== null

/** 真实的 D1 迁移 SQL（云侧 schema 唯一事实来源）。 */
export const MIGRATION_SQL = readFileSync(
  new URL('../cloudflare/migrations/0001_kanban_sync.sql', import.meta.url),
  'utf8',
)

/** 测试用 Bearer 令牌（与 makeWorkerEnv 的 CLOUD_SYNC_TOKEN 一致）。 */
export const TOKEN = 'c2-test-token-0123456789abcdef'
export const GITHUB_SECRET = 'c2-github-webhook-secret'
export const FEISHU_TOKEN = 'c2-feishu-verification-token'
export const FEISHU_ENCRYPT_KEY = 'c2-feishu-encrypt-key'
export const DINGTALK_SIGN_SECRET = 'c2-dingtalk-sign-secret'
export const DINGTALK_ACCESS_TOKEN = 'c2-dingtalk-access-token'
export const GENERIC_TOKEN = 'c2-generic-ingress-token'

class MemoryStatement {
  constructor(database, sql, params = []) {
    this.database = database
    this.sql = sql
    this.params = params
  }

  bind(...params) {
    return new MemoryStatement(this.database, this.sql, params)
  }

  __execute() {
    const statement = this.database.prepare(this.sql)
    const params = this.params.map(value => (value === undefined ? null : value))
    const isRead = /^\s*(select|with|pragma)\b/i.test(this.sql)
    if (isRead) {
      const results = statement.all(...params)
      return { success: true, results, meta: { changes: 0, last_row_id: 0, duration: 0 } }
    }
    const result = statement.run(...params)
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0),
        duration: 0,
      },
    }
  }

  async all() { return this.__execute() }
  async first() { const result = this.__execute(); return result.results[0] ?? null }
  async run() { const result = this.__execute(); return { success: true, meta: result.meta } }
}

/** D1 兼容层：内存 SQLite + batch 事务语义（任一语句失败整体回滚）。 */
export class MemoryD1 {
  constructor(migrationSql = MIGRATION_SQL) {
    if (!DatabaseSync) throw new Error('node:sqlite 不可用：请使用 Node >= 22.13')
    this.database = new DatabaseSync(':memory:')
    if (migrationSql) this.database.exec(migrationSql)
    /** 最近一次 batch 的语句数（用于断言 push 的 D1 语句数上限）。 */
    this.lastBatchSize = 0
  }

  prepare(sql) { return new MemoryStatement(this.database, sql) }

  async batch(statements) {
    this.lastBatchSize = statements.length
    this.database.exec('BEGIN')
    try {
      const results = statements.map(statement => statement.__execute())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  /** 直接查询（测试断言用，不经过 Worker）。 */
  all(sql, ...params) { return this.database.prepare(sql).all(...params) }

  one(sql, ...params) { return this.database.prepare(sql).get(...params) ?? null }

  exec(sql) { this.database.exec(sql) }

  close() { this.database.close() }
}

/**
 * 构造 Worker env：内存 D1（已执行迁移）+ 与测试常量一致的 Worker secrets。
 * 需要覆盖某来源「未配置」时传 `{ GITHUB_WEBHOOK_SECRET: undefined }`。
 */
export function makeWorkerEnv(overrides = {}) {
  return {
    DB: new MemoryD1(MIGRATION_SQL),
    CLOUD_SYNC_TOKEN: TOKEN,
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    FEISHU_VERIFICATION_TOKEN: FEISHU_TOKEN,
    DINGTALK_SIGN_SECRET: DINGTALK_SIGN_SECRET,
    INGRESS_GENERIC_TOKEN: GENERIC_TOKEN,
    ...overrides,
  }
}

/**
 * 调用 Worker：自动设置 Bearer（token=null 时不设置）并解析 JSON。
 * @returns {{status:number, headers:Headers, text:string, json:any}}
 */
export async function callWorker(env, path, { method = 'GET', token = TOKEN, headers = {}, body, rawBody, now = Date.now() } = {}) {
  const init = { method, headers: { ...headers } }
  if (token !== null) init.headers.authorization = `Bearer ${token}`
  if (rawBody !== undefined) {
    init.body = rawBody
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = init.headers['content-type'] || 'application/json'
  }
  const response = await handleRequest(new Request(`https://worker.test${path}`, init), env, { now })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, headers: response.headers, text, json }
}
