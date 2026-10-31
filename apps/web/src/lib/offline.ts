import {
  DEFAULT_AUDIO_LEVEL,
  streamUrlOf,
  type AudioLevel,
  type Track,
} from '@pterosaur/shared/types'
import {
  audioKey,
  getAllMeta,
  getSaved,
  hasSavedAudio,
  listSaved,
  removeSaved as removeSavedEntries,
  saveAudio,
  saveReasonOf,
  type SaveReason,
} from './mediaCache.js'

/**
 * 离线保存的**下载**逻辑（页面侧）：用户显式保存，或由调度器自动预取。
 *
 * - 显式保存走这里：`fetch('/stream/...')` 整段取回 → 写 IDB，**不经 SW**（SW 已不拦截
 *   请求，见 ADR-060），也不经过浏览器缓存写入之外的任何中间层；
 * - 自动预取走 SW 的消息通道（`lib/prefetch.ts` → `PREFETCH_AUDIO`），两者写的是同一份池。
 *
 * 播放即保存（`saveOnPlay`）与显式保存走同一条 `saveTrackOffline`：幂等、失败静默。
 */

/** 一次下载的结果。 */
export type SaveOutcome =
  | { kind: 'saved' }
  /** 403：VIP / 版权受限，需登录。 */
  | { kind: 'needLogin' }
  | { kind: 'failed'; message: string }

/** 下载一首并写入离线保存；已保存则直接返回 `saved`（幂等）。 */
export async function saveTrackOffline(
  track: Track,
  level: AudioLevel = DEFAULT_AUDIO_LEVEL,
): Promise<SaveOutcome> {
  if (await hasSavedAudio(track.source, track.id, level)) {
    // 已存在（多半来自自动预取）：保留字节，只把来源升级为 explicit，不必重新下载
    await markExplicit(track, level)
    return { kind: 'saved' }
  }

  let res: Response
  try {
    res = await fetch(streamUrlOf(track, { level }), {
      credentials: 'include',
    })
  } catch {
    return { kind: 'failed', message: '网络不可用' }
  }
  if (res.status === 403) {
    void res.body?.cancel().catch(() => {})
    return { kind: 'needLogin' }
  }
  const mime = res.headers.get('content-type') ?? ''
  if (!res.ok || !mime.startsWith('audio/')) {
    void res.body?.cancel().catch(() => {})
    return { kind: 'failed', message: `下载失败（${res.status}）` }
  }
  const blob = await res.blob()
  if (blob.size === 0) return { kind: 'failed', message: '下载结果为空' }
  await saveAudio(track.source, track.id, level, blob, mime, 'explicit')
  return { kind: 'saved' }
}

/** 把一条已存在的离线保存标记为用户显式保存（不重写 blob）。 */
async function markExplicit(track: Track, level: AudioLevel): Promise<void> {
  const saved = await getSaved(audioKey(track.source, track.id, level))
  if (!saved) return
  await saveAudio(
    track.source,
    track.id,
    level,
    saved.blob,
    saved.meta.mime,
    'explicit',
    saved.meta.lastAccess,
  )
}

/** 单个集合的离线状态：全部保存 / 部分保存 / 未保存。 */
export type CollectionState = 'all' | 'partial' | 'none'

/** 判断一组曲目已保存的比例（只查元数据，不取 blob）。 */
export async function collectionState(
  tracks: readonly Track[],
  level: AudioLevel,
): Promise<CollectionState> {
  if (!tracks.length) return 'none'
  const metas = await getAllMeta()
  const saved = new Set(
    metas.filter((m) => m.kind === 'audio').map((m) => m.key),
  )
  let hits = 0
  for (const t of tracks) {
    if (saved.has(audioKey(t.source, t.id, level))) hits++
  }
  if (hits === 0) return 'none'
  return hits === tracks.length ? 'all' : 'partial'
}

/** 删除若干曲目的离线保存。 */
export async function removeOffline(tracks: readonly Track[]): Promise<void> {
  const metas = await getAllMeta()
  const wanted = new Set(tracks.map((t) => `${t.source}:${t.id}`))
  const keys = metas
    .filter(
      (m) => m.source && m.trackId && wanted.has(`${m.source}:${m.trackId}`),
    )
    .map((m) => m.key)
  if (keys.length) await removeSavedEntries(keys)
}

/** 列出全部离线保存，附来源（供设置弹窗 / 调试）。 */
export async function listOffline(): Promise<
  (Awaited<ReturnType<typeof listSaved>>[number] & { reason: SaveReason })[]
> {
  const items = await listSaved()
  const reasons = await Promise.all(items.map((i) => saveReasonOf(i.key)))
  return items.map((item, i) => ({
    ...item,
    reason: reasons[i] ?? 'auto',
  }))
}
