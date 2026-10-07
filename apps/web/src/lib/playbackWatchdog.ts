/**
 * 播放停滞看门狗与「提前结束」判定的纯逻辑。
 *
 * 弱网下 media element 会进入两类故障态，二者都会让 UI 停在「播放中」却无声：
 * 1. **停滞（stall）**：缓冲耗尽后进度不再前进，但 `paused` 仍为 false；
 * 2. **截断**：上游流被提前关闭，浏览器把已收到的数据当作完整文件而提前触发 `ended`，
 *    此时 `audio.duration` 被钳短到实际收到的时长。
 *
 * 本模块只做判定、不碰 DOM，副作用（`load()` / `play()`）由 `useAudioEngine` 执行，便于单测。
 */

/** readyState 达到该值表示有当前帧与未来数据，可视为「数据就绪」。 */
export const HAVE_FUTURE_DATA = 3

/** 判定停滞所需的静默时长（毫秒）。 */
export const DEFAULT_STALL_MS = 5000

/** 默认恢复次数上限与退避间隔（毫秒）：沿用原设计——3 次、10/15/20 秒递增退避。 */
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_BACKOFF_MS = [10_000, 15_000, 20_000]

/**
 * 提前结束判定：`audio.duration` 比元数据时长短出的**绝对值**（秒）与**比例**下限。
 * 取双阈值（且都满足）以避开 VBR 时长估算误差造成的误判——真截断通常差出数十秒。
 */
export const PREMATURE_END_MIN_DIFF = 10
export const PREMATURE_END_MIN_RATIO = 0.1

export interface WatchdogConfig {
  stallMs: number
  maxRetries: number
  /** 每次恢复后再次允许恢复的等待时长，按次数取用，不足时取末项。 */
  backoffMs: number[]
}

/**
 * 默认退避策略（**所有音源统一**）：3 次、10/15/20 秒递增退避。
 * 前端重试一律沿用此模式（网易云即默认），不做按源区分。
 */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  stallMs: DEFAULT_STALL_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  backoffMs: DEFAULT_BACKOFF_MS,
}

export type WatchdogAction = 'none' | 'recover' | 'giveUp'

export interface PlaybackSnapshot {
  paused: boolean
  currentTime: number
  readyState: number
}

export interface Watchdog {
  /** 每帧喂入快照，返回应执行的动作。 */
  tick(now: number, snapshot: PlaybackSnapshot): WatchdogAction
  /** 记录一次「非正常中断」（提前 ended），返回是否仍允许执行恢复。 */
  noteInterrupt(now: number): boolean
  /** 重置全部状态（换曲 / 卸载时调用）。 */
  reset(): void
  /** 已用恢复次数（观测用）。 */
  retries(): number
}

/**
 * 判断 `ended` 是否由「流被截断」引起：`audio.duration` 被钳短到实际收到的时长，
 * 因而显著短于曲目元数据时长即视为截断。元数据缺失、或差异未达双阈值时不干预，避免误判。
 */
export function isPrematureEnd(
  audioDuration: number,
  trackDuration: number | undefined,
): boolean {
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) return false
  if (
    typeof trackDuration !== 'number' ||
    !Number.isFinite(trackDuration) ||
    trackDuration <= 0
  ) {
    return false
  }
  const diff = trackDuration - audioDuration
  return (
    diff > PREMATURE_END_MIN_DIFF &&
    diff / trackDuration > PREMATURE_END_MIN_RATIO
  )
}

/**
 * 判定「播放实际健康」：未暂停、不在 seek 中、且已有当前帧与未来数据。
 *
 * 用途：缓冲态（buffering）由 waiting/stalled 置位、playing/canplay 解除，但媒体
 * 事件会乱序与误报——典型如 Chromium 在 seek 目标已缓冲时**迟发** waiting（晚于
 * playing，此后 readyState 不再跨越阈值，永远等不到解除事件）；stalled 则仅表示
 * 网络取数暂无进展、不代表播放停滞。凡判定为健康，缓冲必为假，应立即纠正。
 */
export function isPlaybackHealthy(
  paused: boolean,
  seeking: boolean,
  readyState: number,
): boolean {
  return !paused && !seeking && readyState >= HAVE_FUTURE_DATA
}

/** 创建看门狗状态机（无副作用，时间由调用方注入以便测试）。 */
export function createWatchdog(
  config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): Watchdog {
  let retries = 0
  /** 上次确认「有进展」的时刻；-1 表示尚未初始化。 */
  let lastProgressAt = -1
  /** 上一帧的 currentTime。 */
  let lastTime = 0
  /** 上次恢复时的播放位置（用于判断恢复是否成功）。 */
  let recoverBaseline = -1
  /** 退避：在该时刻前不再触发恢复。 */
  let nextRetryAt = 0

  const backoffFor = (n: number): number =>
    config.backoffMs.length
      ? config.backoffMs[Math.min(n - 1, config.backoffMs.length - 1)]
      : 0

  const clearRecovery = () => {
    retries = 0
    recoverBaseline = -1
    nextRetryAt = 0
  }

  return {
    tick(now, s) {
      if (s.paused) {
        // 暂停即视为新一轮：计时与恢复预算全部复位
        clearRecovery()
        lastProgressAt = now
        lastTime = s.currentTime
        return 'none'
      }
      if (lastProgressAt < 0) {
        lastProgressAt = now
        lastTime = s.currentTime
        return 'none'
      }
      // 尚未起播（位置仍为 0）：交由起播超时兜底，看门狗不介入，
      // 以免与起播流程互相打断（recover 的 load() 会中断未 settle 的 play()）
      if (s.currentTime <= 0) {
        lastProgressAt = now
        lastTime = s.currentTime
        recoverBaseline = -1
        return 'none'
      }
      // 有进展：readyState 足够或时间在前进
      const progressed =
        s.readyState >= HAVE_FUTURE_DATA || s.currentTime > lastTime + 0.01
      lastTime = s.currentTime
      if (progressed) {
        lastProgressAt = now
        // 恢复成功：位置显著超过恢复点，清零重试预算
        if (recoverBaseline >= 0 && s.currentTime > recoverBaseline + 1)
          clearRecovery()
        return 'none'
      }
      // 停滞：静默与退避都满足后才动作
      if (now - lastProgressAt < config.stallMs) return 'none'
      if (now < nextRetryAt) return 'none'
      if (retries >= config.maxRetries) return 'giveUp'
      retries += 1
      recoverBaseline = s.currentTime
      nextRetryAt = now + backoffFor(retries)
      lastProgressAt = now
      return 'recover'
    },

    noteInterrupt(now) {
      if (retries >= config.maxRetries) return false
      retries += 1
      recoverBaseline = lastTime
      nextRetryAt = now + backoffFor(retries)
      lastProgressAt = now
      return true
    },

    reset() {
      clearRecovery()
      lastProgressAt = -1
      lastTime = 0
    },

    retries: () => retries,
  }
}
