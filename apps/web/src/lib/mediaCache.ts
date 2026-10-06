import { canonicalNeteaseImage } from '@pterosaur/shared/image'
import { DEFAULT_AUDIO_LEVEL, type MusicSource } from '@pterosaur/shared/types'
import {
  MEDIA_META_STORE,
  MEDIA_STORE,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
} from './idb.js'

/**
 * 媒体缓存（音频 + 封面）的领域逻辑与 IndexedDB 存取。
 *
 * 音频与封面同属非结构化数据，**共用一个 IndexedDB 存储池与同一个 16GB LRU 预算**。
 *
 * - 纯函数（`audioKey` / `imageKey` / `parseRange` / `responseFromBlob` / `pickEvictions`）不引用
 *   `self` / `window` / `caches`，可被 `sw.ts` 独立打包并被单测直接覆盖。
 * - blob 与元数据分存两个 store：LRU 淘汰只遍历轻量元数据，不触碰 blob。
 */

/** 缓存容量上限（字节），16GB；实际生效值还会受浏览器配额约束。 */
export const CAP_BYTES = 16 * 1024 ** 3
/** 默认音质档位（与后端 `/stream` 默认一致；单一来源见 shared 的 DEFAULT_AUDIO_LEVEL）。 */
export const DEFAULT_LEVEL = DEFAULT_AUDIO_LEVEL
/** 配额安全系数：有效上限取 min(16GB, 配额 * 该系数)。 */
export const QUOTA_SAFETY = 0.9
/** 封面缓存有效期：7 天（毫秒）。从写入时刻起算，到期后访问即回源刷新（与外壳 7 天策略对齐）。 */
export const IMAGE_TTL_MS = 7 * 24 * 3600 * 1000
/** 封面缓存 key 前缀。 */
const IMAGE_PREFIX = 'image|'

/** 缓存条目类别：音频或封面。 */
export type MediaKind = 'audio' | 'image'

export interface MediaMeta {
  /** 缓存 key：音频为 `${source}:${id}|${level}`，封面为 `image|${规范化后的 url}`（见 imageKey）。 */
  key: string
  /** 条目类别，用于用量分项统计。 */
  kind: MediaKind
  /** 音质档位（仅音频）。 */
  level?: string
  /** 音源（仅音频）。 */
  source?: MusicSource
  /** 曲目 id（仅音频）。 */
  trackId?: string
  mime: string
  size: number
  /** 最近一次访问时间戳（毫秒），LRU 依据。 */
  lastAccess: number
  /**
   * 写入缓存的时间戳（毫秒），封面过期依据。
   * 旧数据可能缺失：视作「很久以前写入」→ 封面按过期处理（下次回源刷新一次）。
   */
  cachedAt?: number
}

export interface CachedMedia {
  meta: MediaMeta
  blob: Blob
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

/**
 * 由封面地址生成缓存 key（含 `param` 查询串，故不同尺寸各占一条）。
 *
 * 键先经 `canonicalNeteaseImage` 规范化：网易云会随机轮换 p1–pN 镜像主机（见
 * shared/image 与 ADR-020），规范化后「同一封面 + 同一尺寸」无论来自哪个主机、
 * 新数据还是旧持久化数据，都落在同一条缓存上。
 */
export function imageKey(url: string | URL): string {
  return (
    IMAGE_PREFIX +
    canonicalNeteaseImage(typeof url === 'string' ? url : url.href)
  )
}

/** 结合浏览器配额计算有效容量上限。 */
export function effectiveCap(quota: number | null | undefined): number {
  if (!quota || !Number.isFinite(quota) || quota <= 0) return CAP_BYTES
  return Math.min(CAP_BYTES, Math.floor(quota * QUOTA_SAFETY))
}

/**
 * 判断请求的 `Range` 头是否表达「从 0 起的整文件」语义：无 Range，或 `bytes=0-` / `bytes=0-N`
 * （部分浏览器会用 `bytes=0-1` 之类的短前缀探测资源，同样应走整文件路径）。
 * 仅这类请求由 SW 下载并缓存；起点 > 0 的 seek 切片不接管、由浏览器直接请求网络（见 ADR-012 后续修订）。
 */
export function isWholeFileRange(rangeHeader: string | null): boolean {
  if (rangeHeader === null) return true
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) return false
  return m[1] === '0'
}

/**
 * 判断响应是否覆盖整个文件（整文件可入缓存）：`200`（无 `Content-Range`），
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

/**
 * 解析 HTTP Range 头，返回闭区间 `[start, end]`；不可满足时返回 `null`。
 * 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix` 三种形式。
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const startRaw = m[1]
  const endRaw = m[2]
  let start: number
  let end: number

  if (startRaw === '') {
    // 后缀范围：最后 N 字节
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Number(endRaw)
  }

  if (!Number.isFinite(start) || start < 0 || start >= size) return null
  if (!Number.isFinite(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

/** 基于缓存的 blob 构造响应：无 Range 返回 200，有 Range 返回 206 切片。 */
export function responseFromBlob(
  meta: MediaMeta,
  blob: Blob,
  rangeHeader: string | null,
): Response {
  const baseHeaders: Record<string, string> = {
    'Content-Type': meta.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }

  const range = rangeHeader ? parseRange(rangeHeader, blob.size) : null
  if (!range) {
    return new Response(blob, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(blob.size) },
    })
  }

  const sliced = blob.slice(range.start, range.end + 1)
  return new Response(sliced, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(sliced.size),
      'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}`,
    },
  })
}

/**
 * 计算为容纳 `incomingSize` 需淘汰的 key 列表（按 `lastAccess` 升序，即最久未用优先）。
 * 音频与封面共用同一份元数据，故淘汰在同一预算内跨类别进行。
 * 纯函数，便于单测；SW 侧再据此删除对应 blob 与元数据。
 */
export function pickEvictions(
  metas: MediaMeta[],
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

// ---- 过期判定（纯函数） ----

/**
 * 判断某条缓存是否已过期：**仅封面**按 {@link IMAGE_TTL_MS} 从写入时刻（`cachedAt`）起算，
 * 音频不限时（仅受 LRU 淘汰）。缺 `cachedAt` 的旧封面视作 `0`（很久以前）→ 判为过期。
 */
export function isExpired(meta: MediaMeta, now: number = Date.now()): boolean {
  if (meta.kind !== 'image') return false
  return now - (meta.cachedAt ?? 0) >= IMAGE_TTL_MS
}

/** 从元数据列表筛出所有已过期的缓存 key（供启动期清扫）。 */
export function expiredKeys(
  metas: MediaMeta[],
  now: number = Date.now(),
): string[] {
  return metas.filter((m) => isExpired(m, now)).map((m) => m.key)
}

// ---- IndexedDB 存取 ----

/** 读取缓存（blob + 元数据）；任一缺失即视为未命中。 */
export async function getCached(key: string): Promise<CachedMedia | null> {
  const [meta, blob] = await Promise.all([
    idbGet<MediaMeta>(MEDIA_META_STORE, key),
    idbGet<Blob>(MEDIA_STORE, key),
  ])
  if (!meta || !(blob instanceof Blob)) return null
  return { meta, blob }
}

/** 写入 blob 与元数据。 */
export async function putCached(meta: MediaMeta, blob: Blob): Promise<void> {
  await idbPut(MEDIA_STORE, blob, meta.key)
  await idbPut(MEDIA_META_STORE, meta)
}

/** 更新某条缓存的最后访问时间。 */
export async function touchCached(
  key: string,
  now: number = Date.now(),
): Promise<void> {
  const meta = await idbGet<MediaMeta>(MEDIA_META_STORE, key)
  if (!meta) return
  meta.lastAccess = now
  await idbPut(MEDIA_META_STORE, meta)
}

/** 删除若干缓存（blob 与元数据）。 */
export async function deleteCached(keys: string[]): Promise<void> {
  for (const key of keys) {
    await idbDelete(MEDIA_STORE, key)
    await idbDelete(MEDIA_META_STORE, key)
  }
}

/** 读取全部元数据（轻量，供 LRU 与用量统计）。 */
export function getAllMeta(): Promise<MediaMeta[]> {
  return idbGetAll<MediaMeta>(MEDIA_META_STORE)
}

/** 清空全部媒体缓存（音频 + 封面）。 */
export async function clearMediaCache(): Promise<void> {
  await idbClear(MEDIA_STORE)
  await idbClear(MEDIA_META_STORE)
}

/** 媒体缓存用量：总量 + 按类别分项（音频 / 封面）。 */
export interface MediaUsage {
  /** 条目总数。 */
  count: number
  /** 总字节。 */
  bytes: number
  /** 音频字节。 */
  audioBytes: number
  /** 封面字节。 */
  imageBytes: number
}

/** 统计媒体缓存用量。 */
export async function mediaUsage(): Promise<MediaUsage> {
  const metas = await getAllMeta()
  let bytes = 0
  let audioBytes = 0
  let imageBytes = 0
  for (const m of metas) {
    bytes += m.size
    if (m.kind === 'audio') audioBytes += m.size
    else imageBytes += m.size
  }
  return { count: metas.length, bytes, audioBytes, imageBytes }
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
