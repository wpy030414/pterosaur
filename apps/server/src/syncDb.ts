import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 云同步的服务端存储：**嵌入式 SQLite**（`node:sqlite`，Node ≥ 22.5）。
 *
 * 相比此前的「每账号一个 JSON 文件」，单库单表更适合数据规模：密钥即主键、磁盘索引、
 * WAL 并发读；用一张表把 library 当**文档**存（`state` 列为 JSON），故不涉及关系建模。
 *
 * - 库文件：`<DATA_DIR>/sync.db`；表 `sync_docs(key, state, rev, updated_at)`。
 * - `key` 取 `<source>-<accountId>`（调用方传入，见 app.ts 的 `syncKey`）。
 * - `rev` 为**服务端**单调版本号（每次写入 +1），用于 SSE 回声判定与「云端是否更新」。
 * - 首次建库时把旧的 `<DATA_DIR>/sync/*.json` 一次性迁移进来（`INSERT OR IGNORE`，不覆盖已有行）。
 *
 * 本模块只管存取，**不做形状校验**（校验与体积上限在 `syncStore.ts`）。
 * 连接按数据目录缓存；测试可调用 {@link closeSyncDb} 释放句柄。
 */

/** 存储行（`state` 为 LibraryData 的 JSON 文本）。 */
export interface SyncRow {
  state: string
  rev: number
  updatedAt: number
}

const conns = new Map<string, DatabaseSync>()

/** 某数据目录下的库文件路径。 */
function dbPath(dir: string): string {
  return join(dir, 'sync.db')
}

/** 打开（并缓存）某数据目录下的同步库；首次打开建表并迁移旧 JSON。 */
export function syncDb(dir: string): DatabaseSync {
  const path = dbPath(dir)
  const cached = conns.get(path)
  if (cached) return cached
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS sync_docs (' +
      'key TEXT PRIMARY KEY, ' +
      'state TEXT NOT NULL, ' +
      'rev INTEGER NOT NULL, ' +
      'updated_at INTEGER NOT NULL)',
  )
  migrateFromJson(db, dir)
  conns.set(path, db)
  return db
}

/** 读取一行；不存在返回 `null`。 */
export function getRow(dir: string, key: string): SyncRow | null {
  const row = syncDb(dir)
    .prepare('SELECT state, rev, updated_at FROM sync_docs WHERE key = ?')
    .get(key) as { state: string; rev: number; updated_at: number } | undefined
  if (!row) return null
  return { state: row.state, rev: row.rev, updatedAt: row.updated_at }
}

/** 整行写入（存在则覆盖），返回写入后的行。 */
export function putRow(
  dir: string,
  key: string,
  state: string,
  rev: number,
  updatedAt: number,
): SyncRow {
  syncDb(dir)
    .prepare(
      'INSERT INTO sync_docs (key, state, rev, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET ' +
        'state = excluded.state, rev = excluded.rev, updated_at = excluded.updated_at',
    )
    .run(key, state, rev, updatedAt)
  return { state, rev, updatedAt }
}

/** 删除一行；不存在静默。 */
export function deleteRow(dir: string, key: string): void {
  syncDb(dir).prepare('DELETE FROM sync_docs WHERE key = ?').run(key)
}

/** 关闭并移出某数据目录的连接缓存（供测试释放句柄）。 */
export function closeSyncDb(dir: string): void {
  const path = dbPath(dir)
  const db = conns.get(path)
  if (!db) return
  try {
    db.close()
  } catch {
    /* 已关闭则忽略 */
  }
  conns.delete(path)
}

/**
 * 把旧的 `<dir>/sync/*.json` 一次性导入（`INSERT OR IGNORE`，已存在的主键不覆盖）。
 * 单个文件损坏则跳过；不删除源文件（保留兜底）。
 */
function migrateFromJson(db: DatabaseSync, dir: string): void {
  const jsonDir = join(dir, 'sync')
  if (!existsSync(jsonDir)) return
  let names: string[]
  try {
    names = readdirSync(jsonDir)
  } catch {
    return
  }
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO sync_docs (key, state, rev, updated_at) VALUES (?, ?, 1, ?)',
  )
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(jsonDir, name), 'utf8')) as {
        state?: unknown
        updatedAt?: unknown
      }
      if (
        !parsed ||
        typeof parsed.state !== 'object' ||
        parsed.state === null
      ) {
        continue
      }
      const updatedAt =
        typeof parsed.updatedAt === 'number' &&
        Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : Date.now()
      stmt.run(
        name.slice(0, -'.json'.length),
        JSON.stringify(parsed.state),
        updatedAt,
      )
    } catch {
      /* 单个文件损坏 → 跳过 */
    }
  }
}
