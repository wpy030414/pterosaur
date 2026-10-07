import {
  audioLevelOrDefault,
  isMusicSource,
  type AudioLevel,
  type MusicSource,
  type Track,
} from '@pterosaur/shared/types'
import { audioKey } from './mediaCache.js'

/**
 * SW 预载音频的消息协议（页面 ⇄ Service Worker）。
 *
 * 抽成独立**纯模块**的目的：SW 的 `message` 边界无法被单测直接覆盖，把「消息构造 / 校验」
 * 集中于此即可用普通单测验证。协议仅一条——页面请求 SW **主动**整段下载某曲音频写入媒体
 * 缓存（落法 B：页面不接字节，见 ADR-037）。
 *
 * 另注：SW 自身发起的 `fetch()` **不会**被它自己的 fetch 处理器拦截，故 SW 内
 * `fetch('/stream/...')` 直连后端、不递归。
 */

/** 预载音频消息的类型标识。 */
export const PREFETCH_AUDIO = 'PREFETCH_AUDIO' as const

/** 页面 → SW：预载指定曲目的音频。 */
export interface PrefetchAudioMessage {
  type: typeof PREFETCH_AUDIO
  source: MusicSource
  id: string
  level: AudioLevel
}

/** 页面侧构造预载消息。 */
export function prefetchAudioMessage(
  track: Pick<Track, 'source' | 'id'>,
  level: AudioLevel,
): PrefetchAudioMessage {
  return { type: PREFETCH_AUDIO, source: track.source, id: track.id, level }
}

/** SW 侧解析出的合法预载请求（含据以写入缓存的 `key`）。 */
export interface ParsedPrefetchAudio {
  source: MusicSource
  id: string
  level: AudioLevel
  /** 媒体缓存 key（`<source>:<id>|<level>`，与 `audioKey` 同源）。 */
  key: string
}

/**
 * SW 侧解析 + 校验预载消息。消息来自页面、视为不可信输入：非对象 / 类型不符 /
 * 源或 id 非法一律返回 `null`；档位非法或缺失回退缺省档（`audioLevelOrDefault`）。
 */
export function parsePrefetchAudio(data: unknown): ParsedPrefetchAudio | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type !== PREFETCH_AUDIO) return null
  if (!isMusicSource(d.source)) return null
  if (typeof d.id !== 'string' || !d.id) return null
  const level = audioLevelOrDefault(d.level)
  return {
    source: d.source,
    id: d.id,
    level,
    key: audioKey(d.source, d.id, level),
  }
}
