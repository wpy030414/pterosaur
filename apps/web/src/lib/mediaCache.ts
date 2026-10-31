import { DEFAULT_AUDIO_LEVEL, type MusicSource } from '@pterosaur/shared/types'
import {
  MEDIA_META_STORE,
  MEDIA_STORE,
  OFFLINE_META_STORE,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
} from './idb.js'

/**
 * 离线保存（IndexedDB）。**只保存音频，不缓存封面**——封面交给浏览器 HTTP 缓存（ADR-060）。
 *
 * 本模块是「应用层知道自己在存东西」的唯一入口：
 *
 * - 播放不再经过它：`<audio>` 直连 `/stream`，靠浏览器原生 HTTP 缓存省流、可 seek；
 * - 这里存的是**用户显式保存**（或队列相邻曲的自动预取）的整曲，供断网 / 离线时播放；
 * - 纯函数（`audioKey` / `pickEvictions` / `effectiveCap` / `isWholeFileResponse`）与服务端
 *   可测，blob 先写、元数据后写，元数据里记 `lastAccess` 供 LRU 淘汰与用量统计。
 */

/** 离线保存容量上限（字节），16GB；实际生效值还会受浏览器配额约束。 */
export const CAP_BYTES = 16 * 1024 ** 3
/** 默认音质档位（与后端 `/stream` 默认一致；单一来源见 shared 的 DEFAULT_AUDIO_LEVEL）。 */
export const DEFAULT_LEVEL = DEFAULT_AUDIO_LEVEL
/** 配额安全系数：有效上限取 min(16GB, 配额 * 该系数)。 */
export const QUOTA_SAFETY = 0.9

/** 离线保存的来源：`auto` 队列自动预取；`explicit` 用户显式保存。 */
export type SaveReason = 'auto' | 'explicit'

/** 一条离线保存记录（不含 blob）。 */
export interface SavedAudio {
  /** 缓存 key：`<source>:<id>|<level>`（见 {@link audioKey}）。 */
  key: string
  source: MusicSource
  trackId: string
  level: string
  mime: string
  size: number
  /** 最近一次访问 / 保存 / 命中的时间戳（毫秒），LRU 依据。 */
  lastAccess: number
}

/**
 * IDB 中一条媒体元数据。v5 起只有音频（离线保存）；`kind` 保留字段以免旧库条目被误读。
 */
export interface MediaMeta {
  key: string
  /** 恒为 `'audio'`；旧库可能残留 `'image'`，启动清扫时删除（见 `sw.ts`）。 */
  kind: 'audio' | 'image'
  level?: string
  source?: MusicSource
  trackId?: string
  mime: string
  size: number
  lastAccess: number
}

/**
 * 由「源 + 曲目 id + 音质档位」生成缓存 key。
 *
 * 前缀带源（`<source>:<id>`，与 `keyOf` 同形）：不同源的曲目可能共享同一原始 id，
 * 不带源会让源 A 的缓存被源 B 命中、播放/下载到**完全错误的音频**。
 */
export function audioKey(
  source: MusicSource,
  id: string,
  level: string = DEFAULT_LEVEL,
): string {
  return `${source}:${id}|${level}`
}

/** 结合浏览器配额计算有效容量上限。 */
export function effectiveCap(quota: number | null | undefined): number {
  if (!quota || !Number.isFinite(quota) || quota <= 0) return CAP_BYTES
  return Math.min(CAP_BYTES, Math.floor(quota * QUOTA_SAFETY))
}

/**
 * 计算为容纳 `incomingSize` 需淘汰的 key 列表（按 `lastAccess` 升序，即最久未用优先）。
 * 纯函数，便于单测；调用方据此删除对应 blob 与元数据。
 */
export function pickEvictions(
  metas: readonly SavedAudio[],
  capBytes: number,
  incomingSize: number,
): string[] {
  const total = metas.reduce((sum, m) => sum + m.size, 0)
  if (total + incomingSize <= capBytes) return []
  const sorted = [...metas].sort((a, b) => a.lastAccess - b.lastAccess)
  const evicted: string[] = []
  let projected = total + incomingSize
  for (const m of sorted) {
    if (projected <= capBytes) break
    evicted.push(m.key)
    projected -= m.size
  }
  return evicted
}

/**
 * 判断响应是否覆盖整个文件（整曲可入离线保存）：`200`（无 `Content-Range`），
 * 或 `206` 且 `Content-Range` 为 `bytes 0-(total-1)/total`——部分 CDN 对无条件请求也回全量 206。
 */
export function isWholeFileResponse(
  status: number,
  contentRange: string | null,
): boolean {
  if (status === 200 && contentRange === null) return true
  if (status !== 206 || contentRange === null) return false
  const m = /^bytes 0-(\d+)\/(\d+)$/.exec(contentRange.trim())
  if (!m) return false
  return Number(m[1]) + 1 === Number(m[2])
}

// ---- IndexedDB 存取 ----

interface StoredMedia {
  meta: MediaMeta
  blob: Blob
}

/** 读取一条离线保存（blob + 元数据）；任一缺失即视为未命中。 */
export async function getSaved(key: string): Promise<StoredMedia | null> {
  const [meta, blob] = await Promise.all([
    idbGet<MediaMeta>(MEDIA_META_STORE, key),
    idbGet<Blob>(MEDIA_STORE, key),
  ])
  if (!meta || meta.kind !== 'audio' || !(blob instanceof Blob)) return null
  return { meta, blob }
}

/** 某曲是否已离线保存（只查元数据，不取 blob）。 */
export async function hasSavedAudio(
  source: MusicSource,
  id: string,
  level: string = DEFAULT_LEVEL,
): Promise<boolean> {
  const meta = await idbGet<MediaMeta>(
    MEDIA_META_STORE,
    audioKey(source, id, level),
  )
  return Boolean(meta && meta.kind === 'audio')
}

/** 读取某条离线保存的来源；无记录（旧数据）视为 `auto`。 */
export async function saveReasonOf(key: string): Promise<SaveReason> {
  const v = await idbGet<SaveReason>(OFFLINE_META_STORE, key)
  return v === 'explicit' ? 'explicit' : 'auto'
}

/** 写入一条离线保存。`lastAccess` 以写入时刻为准；来源记在独立的 `offlineMeta` store。 */
export async function saveAudio(
  source: MusicSource,
  id: string,
  level: string,
  blob: Blob,
  mime: string,
  reason: SaveReason = 'auto',
  now: number = Date.now(),
): Promise<void> {
  const key = audioKey(source, id, level)
  const meta: MediaMeta = {
    key,
    kind: 'audio',
    source,
    trackId: id,
    level,
    mime,
    size: blob.size,
    lastAccess: now,
  }
  await idbPut(MEDIA_STORE, blob, key)
  await idbPut(MEDIA_META_STORE, meta)
  await idbPut(OFFLINE_META_STORE, reason, key)
}

/** 更新某条离线保存的最后访问时间（命中 / 重播时调用）。 */
export async function touchSaved(
  key: string,
  now: number = Date.now(),
): Promise<void> {
  const meta = await idbGet<MediaMeta>(MEDIA_META_STORE, key)
  if (!meta) return
  meta.lastAccess = now
  await idbPut(MEDIA_META_STORE, meta)
}

/** 删除若干离线保存（blob 与元数据）。 */
export async function removeSaved(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await idbDelete(MEDIA_STORE, key)
    await idbDelete(MEDIA_META_STORE, key)
    await idbDelete(OFFLINE_META_STORE, key)
  }
}

/** 读取全部元数据（轻量，供 LRU 与用量统计）。 */
export function getAllMeta(): Promise<MediaMeta[]> {
  return idbGetAll<MediaMeta>(MEDIA_META_STORE)
}

/** 全部离线保存（只含音频，按最近访问降序）。 */
export async function listSaved(): Promise<SavedAudio[]> {
  const metas = await getAllMeta()
  return metas
    .filter((m) => m.kind === 'audio')
    .map((m) => ({
      key: m.key,
      source: m.source ?? 'netease',
      trackId: m.trackId ?? m.key,
      level: m.level ?? DEFAULT_LEVEL,
      mime: m.mime,
      size: m.size,
      lastAccess: m.lastAccess,
    }))
    .sort((a, b) => b.lastAccess - a.lastAccess)
}

/**
 * 清空离线保存。`keepExplicit` 时保留用户显式保存的曲目、只删自动预取的部分
 * （设置弹窗「清除自动预取」用）。
 */
export async function clearOfflineAudio(keepExplicit = false): Promise<void> {
  if (!keepExplicit) {
    await idbClear(MEDIA_STORE)
    await idbClear(MEDIA_META_STORE)
    await idbClear(OFFLINE_META_STORE)
    return
  }
  const metas = await getAllMeta()
  const explicit: string[] = []
  for (const m of metas) {
    if (m.kind === 'audio' && (await saveReasonOf(m.key)) === 'explicit') {
      explicit.push(m.key)
    }
  }
  const keep = new Set(explicit)
  await removeSaved(metas.map((m) => m.key).filter((k) => !keep.has(k)))
}

/** 离线保存用量。 */
export interface OfflineUsage {
  /** 条目数。 */
  count: number
  /** 总字节。 */
  bytes: number
}

/** 统计离线保存用量。 */
export async function offlineUsage(): Promise<OfflineUsage> {
  const metas = await getAllMeta()
  let bytes = 0
  let count = 0
  for (const m of metas) {
    if (m.kind !== 'audio') continue
    bytes += m.size
    count += 1
  }
  return { count, bytes }
}

/** 申请持久化存储并读取浏览器配额（不可用时返回 null）。 */
export async function requestPersistentQuota(): Promise<number | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate)
    return null
  try {
    await navigator.storage.persist?.()
    const { quota } = await navigator.storage.estimate()
    return quota ?? null
  } catch {
    return null
  }
}
