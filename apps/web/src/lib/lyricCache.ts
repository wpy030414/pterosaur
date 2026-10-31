import type { Lyric, Track } from '@pterosaur/shared/types'
import { keyOf } from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { registerCacheCleaner } from './cacheRegistry.js'

/**
 * 歌词内存缓存。
 *
 * 目的：进入沉浸播放页前就预取当前曲目的歌词，使页面打开即显示、无「歌词加载中」
 * 停留。歌词与用户无关（同一首歌对所有账号一致），故仅内存、不持久化、登出不清。
 *
 * 键为 `keyOf(track)`（源 + id）——不同源的曲目可能共享同一原始 id，不带源会串歌词。
 */

/** 缓存条目上限，超出按插入顺序淘汰最旧的一条。 */
const MAX_ENTRIES = 64

const cache = new Map<string, Lyric>()
/** 进行中的请求，用于去重（列表快速切歌时避免同一首重复请求）。 */
const inflight = new Map<string, Promise<void>>()

export function getCachedLyric(track: Track): Lyric | null {
  return cache.get(keyOf(track)) ?? null
}

export function putCachedLyric(track: Track, lyric: Lyric): void {
  const key = keyOf(track)
  // 重新插入以刷新 LRU 顺序
  cache.delete(key)
  cache.set(key, lyric)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * 预取歌词并写入缓存。重复调用自动去重；失败不写入缓存（正式打开时会再拉一次）。
 */
export function prefetchLyric(track: Track): Promise<void> {
  const key = keyOf(track)
  if (cache.has(key)) return Promise.resolve()
  const existing = inflight.get(key)
  if (existing) return existing

  const p = api
    .lyric(track.source, track.id)
    .then((l) => {
      putCachedLyric(track, l)
    })
    .catch(() => {
      /* 预取失败静默忽略 */
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, p)
  return p
}

/** 清空缓存（供测试 / 重置使用）。 */
export function clearLyricCache(): void {
  cache.clear()
  inflight.clear()
}

// 自注册到统一清缓存：新增内存缓存不必再改 clearCaches 的清单
registerCacheCleaner(clearLyricCache)
