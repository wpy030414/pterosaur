import { join } from 'node:path'
import type { LibraryData, SyncEnvelope } from '@pterosaur/shared/types'
import { ROOT_DIR } from './env.js'
import { deleteRow, getRow, upsertRow } from './syncDb.js'

/**
 * 云同步的服务端持久化（对外 API）。存储层已换为嵌入式 SQLite（见 `syncDb.ts`）。
 *
 * - 目录：`process.env.DATA_DIR ?? <仓库根>/.data`，库文件 `<DATA_DIR>/sync.db`。
 * - `userId` 由访客 cookie 解析（`<source>-<accountId>`），只做净化防路径穿越。
 * - **版本号与写入时刻均由服务端指派**（`rev` 每次 +1、`updatedAt = Date.now()`），
 *   避免多设备时钟偏差影响「云端是否更新」的判断。
 * - 读失败**不**降级为「无数据」（见 {@link ReadResult}），由路由回 502，避免误覆盖。
 *
 * 注意：这是 Pterosaur「无状态后端」原则的**有意例外**（见 ADR-016）——服务端开始持久化
 * **访客本人**的资料库数据。`userId` 由访客 cookie 解析，每个用户只能读写自己的记录。
 */

/** 单个用户载荷的体积上限（5MB）；超出视为异常请求拒绝。 */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024

/** 解析数据根目录（可被 `DATA_DIR` 覆盖，便于测试或自定义部署）。 */
export function dataDir(dir = process.env.DATA_DIR): string {
  return dir && dir.trim() ? dir : join(ROOT_DIR, '.data')
}

/** 只允许数字 / 字母 / `_` / `-`，杜绝路径穿越。 */
function sanitizeId(userId: string): string {
  const safe = String(userId).replace(/[^0-9A-Za-z_-]/g, '')
  if (!safe) throw new Error('非法的 userId')
  return safe
}

/** 形状校验要求的基础集合字段（自首个版本即存在，缺失即视为非法载荷）。 */
const COLLECTIONS = [
  'favorites',
  'recent',
  'playlists',
  'savedPlaylists',
  'savedAlbums',
] as const

/**
 * library 形状校验。
 *
 * **只校验基础字段，有意不枚举后续新增字段**：library 未来还会扩展更多内容，为每个字段
 * 单独判定「必填 / 可选」属于污染型设计，也会让缺新字段的旧云端载荷被判非法——
 * 那会使 `readLibrary` 返回 `null`、被当成「云端无数据」，进而被空库覆盖。
 * 因此这里保持宽容：只要基础形状成立、那几项基础集合为数组即可，**其余字段一概放行**；
 * 新增字段一律由客户端 `applyPayload` 归一化兜底（见 `web/lib/sync.ts`）。
 */
export function isLibraryState(v: unknown): v is LibraryData {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return COLLECTIONS.every((k) => Array.isArray(s[k]))
}

/**
 * 读取结果。**必须区分「没有」与「坏了」**：客户端对「没有」的处理是「以本地为准并上传」，
 * 若把「库损坏 / 读失败」也报成「没有」，就会用本地空库抹掉云端副本——这是最坏的数据丢失路径。
 */
export type ReadResult =
  | { kind: 'ok'; envelope: SyncEnvelope }
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }

/** 读取某用户的 library。不存在 → `missing`；存在但解析 / 校验 / 读取失败 → `corrupt`。 */
export function readLibrary(userId: string, dir?: string): ReadResult {
  let key: string
  try {
    key = sanitizeId(userId)
  } catch {
    // 非法 userId 是**请求**问题而非云端数据问题：按「不存在」处理，
    // 不能报 corrupt（那是「云端副本坏了」，客户端会走恢复流程）
    return { kind: 'missing' }
  }
  let row
  try {
    row = getRow(dataDir(dir), key)
  } catch (e) {
    return {
      kind: 'corrupt',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
  if (!row) return { kind: 'missing' }
  try {
    const parsed: unknown = JSON.parse(row.state)
    if (!isLibraryState(parsed))
      return { kind: 'corrupt', reason: '云端载荷形状非法' }
    return {
      kind: 'ok',
      envelope: { state: parsed, rev: row.rev, updatedAt: row.updatedAt },
    }
  } catch (e) {
    return {
      kind: 'corrupt',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 写入某用户的 library（整文档覆盖），返回服务端指派版本后的封套。
 *
 * @throws 当载荷非法或超过 {@link MAX_PAYLOAD_BYTES} 时抛出，供路由层回 400。
 */
export async function writeLibrary(
  userId: string,
  state: LibraryData,
  dir?: string,
): Promise<SyncEnvelope> {
  if (!isLibraryState(state)) throw new Error('非法的同步载荷')
  const json = JSON.stringify(state)
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES)
    throw new Error('同步载荷过大')

  // 原子递增：并发 PUT 不会写出同一个 rev（见 syncDb.upsertRow）
  const row = upsertRow(dataDir(dir), sanitizeId(userId), json, Date.now())
  return { state, rev: row.rev, updatedAt: row.updatedAt }
}

/** 清空某用户的 library；不存在时静默。 */
export async function clearLibrary(
  userId: string,
  dir?: string,
): Promise<void> {
  deleteRow(dataDir(dir), sanitizeId(userId))
}
