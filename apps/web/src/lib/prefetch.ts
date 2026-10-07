import { COVER_LARGE, COVER_SMALL, coverAt } from '@pterosaur/shared/image'
import { keyOf, type AudioLevel, type Track } from '@pterosaur/shared/types'
import { audioKey } from './mediaCache.js'
import { postToServiceWorker } from './pwa.js'
import { preloadCover } from './imageCache.js'
import { prefetchLyric } from './lyricCache.js'
import { prefetchAudioMessage } from './prefetchProtocol.js'

/**
 * 队列预载调度器：在网络良好且播放侧空闲时，预热队列**相邻曲目**（前后各 {@link PREFETCH_RADIUS}
 * 首）的音频 / 封面 / 歌词，使切歌近乎瞬时（见 ADR-037）。
 *
 * 分工：
 * - **纯函数**（`prefetchTargets` / `isNetworkGood` / `canPrefetch` / `prefetchKey`）不触浏览器 API，可单测；
 * - **副作用函数**（`prefetchTrack`）触网与缓存；
 * - **调度器**（`createPrefetchScheduler`）以注入的 `gate`/`run`/`idle` 解耦，便于确定性单测。
 *
 * 音频经 SW 消息由 SW 自行整段下载（页面不接字节）；封面走 `preloadCover`（`<img>` 的
 * `destination === 'image'`，被 SW `handleImage` 自动落同一 IDB 池）；歌词入内存缓存。
 */

/** 预载半径：前后各 N 首。 */
export const PREFETCH_RADIUS = 2
/**
 * 预载封面档位：列表行/播放条用 SMALL、沉浸页用 LARGE——两者是**独立缓存条目**（key 含 `param`），
 * 故两档都预。若日后偏保守，收敛为 `[COVER_LARGE]` 即可。
 */
export const PREFETCH_COVER_PXES = [COVER_SMALL, COVER_LARGE] as const
/** current 落定后的静置延迟（ms）：快速连跳时不断重置，收手后才发车，避免为「一闪而过」的曲白下。 */
export const PREFETCH_SETTLE_MS = 2500
/** 相邻两首预载之间的空闲间隔（ms）。 */
export const PREFETCH_GAP_MS = 1500
/** 去重表上限（有界内存）。 */
const REGISTRY_MAX = 512

/** Network Information API 的最小结构类型（避免依赖 `lib.dom` 的 `NetworkInformation`）。 */
export interface ConnectionLike {
  saveData?: boolean
  effectiveType?: string
}

/**
 * 计算预载目标：队列中相对 `index` 的 `±1…±radius` 曲目，按长度回绕、按 `keyOf` 去重、
 * 剔除当前曲。`index` 非法或队列长度 ≤ 1 时返回空。
 * 顺序为 `+1,-1,+2,-2…`——若调度中途被取消，先排最可能用到的下一首。
 */
export function prefetchTargets(
  queue: Track[],
  index: number,
  radius = PREFETCH_RADIUS,
): Track[] {
  const n = queue.length
  if (n <= 1 || index < 0 || index >= n) return []
  const out: Track[] = []
  const seen = new Set<string>([keyOf(queue[index])])
  for (let d = 1; d <= radius; d++) {
    for (const off of [d, -d]) {
      const t = queue[(((index + off) % n) + n) % n]
      if (!t) continue
      const k = keyOf(t)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

/**
 * 网络是否「良好且非省流」：离线 → false；省流模式 → false；有效网络类型为
 * `slow-2g/2g/3g` → false；其余（含 `4g`、未知类型、`connection` 缺失）→ true。
 */
export function isNetworkGood(
  online: boolean,
  connection?: ConnectionLike,
): boolean {
  if (!online) return false
  if (!connection) return true
  if (connection.saveData === true) return false
  const et = connection.effectiveType
  return !(et === 'slow-2g' || et === '2g' || et === '3g')
}

/**
 * 综合门控：未处于缓冲态、当前曲已就绪到 `HAVE_FUTURE_DATA`（`readyState ≥ 3`）、网络良好。
 * 三者同时成立才值得预载——避免与当前曲首缓冲抢带宽。
 */
export function canPrefetch(input: {
  online: boolean
  connection?: ConnectionLike
  buffering: boolean
  readyState: number
}): boolean {
  if (input.buffering) return false
  if (!(input.readyState >= 3)) return false
  return isNetworkGood(input.online, input.connection)
}

/** 预载去重键：与 SW 的 `audioKey` 同形（`<source>:<id>|<level>`），含 `level` 故换档会重发。 */
export function prefetchKey(
  track: Pick<Track, 'source' | 'id'>,
  level: AudioLevel,
): string {
  return audioKey(track.source, track.id, level)
}

// ---- 去重表（有界，仿 imageCache 的 ready 表） ----
const registry = new Set<string>()

export function hasPrefetched(
  track: Pick<Track, 'source' | 'id'>,
  level: AudioLevel,
): boolean {
  return registry.has(prefetchKey(track, level))
}

/** 登记某曲已请求过预载（重新插入刷新插入序，超限淘汰最旧）。 */
export function markPrefetched(
  track: Pick<Track, 'source' | 'id'>,
  level: AudioLevel,
): void {
  const k = prefetchKey(track, level)
  registry.delete(k)
  registry.add(k)
  while (registry.size > REGISTRY_MAX) {
    const oldest = registry.values().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
}

/** 清空去重表（供登录/登出清缓存联动、测试重置）。 */
export function clearPrefetchRegistry(): void {
  registry.clear()
}

/**
 * 预载单首曲目：音频（经 SW 消息）+ 封面（两档）+ 歌词。幂等——已请求过则跳过。
 * **先登记再执行**：预载失败在本会话内不重试（避免失败循环），见 ADR-037。
 */
export function prefetchTrack(track: Track, level: AudioLevel): void {
  if (hasPrefetched(track, level)) return
  markPrefetched(track, level)
  postToServiceWorker(prefetchAudioMessage(track, level))
  for (const px of PREFETCH_COVER_PXES) {
    preloadCover(coverAt(track.cover, px))
  }
  void prefetchLyric(track)
}

// ---- 调度器 ----

export interface PrefetchSchedulerDeps {
  /** 现场门控：每一步执行前调用；返回 false 即停止后续（实时读 navigator / 播放器状态）。 */
  gate: () => boolean
  /** 执行单首预载；默认 {@link prefetchTrack}。 */
  run?: (track: Track, level: AudioLevel) => void
  /** 空闲调度；默认 `requestIdleCallback`（退化 `setTimeout`）。 */
  idle?: (cb: () => void, timeoutMs: number) => number
  /** 取消 `idle`；默认 `cancelIdleCallback`（退化 `clearTimeout`）。 */
  cancelIdle?: (id: number) => void
  settleMs?: number
  gapMs?: number
}

export interface PrefetchScheduler {
  /** 以新目标集重排：重置静置计时、取消未开始的任务（不影响已发出的请求）。 */
  schedule(targets: Track[], level: AudioLevel): void
  /** 取消排队与未开始的任务。 */
  cancel(): void
}

function defaultIdle(cb: () => void, timeoutMs: number): number {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(() => cb(), { timeout: timeoutMs })
  }
  return setTimeout(cb, timeoutMs) as unknown as number
}

function defaultCancelIdle(id: number): void {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id)
  else clearTimeout(id)
}

/**
 * 创建预载调度器。用「代际号 `gen`」实现取消：每次 `schedule`/`cancel` 递增 `gen`，
 * 在途回调发现代际不符即自行终止。`settle` 用真实定时器（防抖），曲间用 `idle`（空闲才跑）。
 */
export function createPrefetchScheduler(
  deps: PrefetchSchedulerDeps,
): PrefetchScheduler {
  const run = deps.run ?? prefetchTrack
  const idle = deps.idle ?? defaultIdle
  const cancelIdle = deps.cancelIdle ?? defaultCancelIdle
  const settleMs = deps.settleMs ?? PREFETCH_SETTLE_MS
  const gapMs = deps.gapMs ?? PREFETCH_GAP_MS

  let gen = 0
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let idleHandle: number | null = null

  const clearPending = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    if (idleHandle !== null) {
      cancelIdle(idleHandle)
      idleHandle = null
    }
  }

  const step = (
    myGen: number,
    targets: Track[],
    level: AudioLevel,
    i: number,
  ): void => {
    if (myGen !== gen) return
    idleHandle = null
    if (!deps.gate()) return
    const track = targets[i]
    if (track) run(track, level)
    if (i + 1 < targets.length) {
      idleHandle = idle(() => step(myGen, targets, level, i + 1), gapMs)
    }
  }

  return {
    schedule(targets, level) {
      gen++
      clearPending()
      if (!targets.length) return
      const myGen = gen
      settleTimer = setTimeout(() => {
        settleTimer = null
        step(myGen, targets, level, 0)
      }, settleMs)
    },
    cancel() {
      gen++
      clearPending()
    },
  }
}
