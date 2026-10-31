import type { AudioLevel, MusicSource } from '@pterosaur/shared/types'
import { audioKey, getSaved, removeSaved } from './mediaCache.js'
import { registerCacheCleaner } from './cacheRegistry.js'

/**
 * 本地副本播放：**只要某曲已离线保存，播放就优先走本地**（在线亦然，ADR-060 修订）。
 *
 * 听过一遍的曲目再播不应再向服务器要一次音频——省的是带宽、后端取流与上游风控的压力。
 * 代价是失去 Range 流式起播（要等 IndexedDB 把整曲读成 `blob:`），故 `useAudioEngine`
 * 为「起播迟迟不来」准备了回退到流地址的兜底。断网时本地副本是唯一可行来源。
 *
 * 本模块不持有播放器状态：这里只提供「查得到就给出 URL」与「释放」两件事，外加一个
 * 可单测的纯函数 {@link pickPlaybackSrc}。
 */

/** 已创建的 object URL（按缓存 key 去重，重复命中复用同一个 URL）。 */
const objects = new Map<string, string>()

/**
 * 选择播放源：**已保存就用本地 `blob:`**（无论在线与否），否则用流地址。
 * `stream` 为空（没有当前曲）时原样返回空。
 */
export function pickPlaybackSrc(
  savedUrl: string | null | undefined,
  stream: string,
): string {
  if (!stream) return ''
  return savedUrl ? savedUrl : stream
}

/**
 * 查某曲的离线副本；命中则返回可播放的 `blob:` 地址，未保存返回 `null`。
 * 同一曲重复调用复用同一个 URL（列表 / 歌词面板可能并发查询）。
 */
export async function lookupSavedAudio(
  source: MusicSource,
  id: string,
  level: AudioLevel,
): Promise<string | null> {
  const key = audioKey(source, id, level)
  const existing = objects.get(key)
  if (existing) return existing
  const saved = await getSaved(key)
  if (!saved) return null
  // 并发查询可能已有人先建好：以先写入者为准，后来者释放自己的 URL
  const again = objects.get(key)
  if (again) return again
  const url = URL.createObjectURL(saved.blob)
  objects.set(key, url)
  return url
}

/** 当前因离线而持有 object URL 的曲目数（诊断 / 测试用）。 */
export function heldObjectUrls(): number {
  return objects.size
}

/** 释放全部已创建的 object URL（登录 / 退出清缓存时调用）。 */
export function releaseSavedUrls(): void {
  for (const url of objects.values()) URL.revokeObjectURL(url)
  objects.clear()
}

/**
 * 删除某曲的离线保存，并释放其 object URL——播放中由 `useAudioEngine` 先行切回流地址，
 * 故这里直接吊销是安全的（若仍在播放，调用方须先换源）。
 */
export async function removeSavedAudio(
  source: MusicSource,
  id: string,
  level: AudioLevel,
): Promise<void> {
  const key = audioKey(source, id, level)
  const url = objects.get(key)
  if (url) {
    URL.revokeObjectURL(url)
    objects.delete(key)
  }
  await removeSaved([key])
}

// 自注册到统一清缓存：清缓存时释放内存中的 object URL
registerCacheCleaner(releaseSavedUrls)
