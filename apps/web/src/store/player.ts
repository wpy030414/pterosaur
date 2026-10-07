import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { RepeatMode, Track, MusicSource } from '@pterosaur/shared/types'
import { streamUrlOf, keyOf, type AudioLevel } from '@pterosaur/shared/types'
import { seekTo } from '../hooks/audioElement.js'

/**
 * 播放模式：把「随机」与「循环」合并为单一 UI 概念，供播放条的合并按钮循环切换。
 *
 * - `order`      顺序播放（不循环）
 * - `repeat-all` 列表循环
 * - `repeat-one` 单曲循环
 * - `shuffle`    随机播放
 */
export type PlayMode = 'order' | 'repeat-all' | 'repeat-one' | 'shuffle'

/** 合并模式的循环顺序。 */
const MODE_CYCLE: PlayMode[] = ['order', 'repeat-all', 'repeat-one', 'shuffle']

/** 由底层 `shuffle` + `repeat` 派生当前播放模式。 */
export function currentPlayMode(
  shuffle: boolean,
  repeat: RepeatMode,
): PlayMode {
  if (shuffle) return 'shuffle'
  if (repeat === 'off') return 'order'
  if (repeat === 'one') return 'repeat-one'
  return 'repeat-all'
}

/** 播放模式对应的底层 `shuffle` / `repeat` 组合。 */
function modeToState(mode: PlayMode): { shuffle: boolean; repeat: RepeatMode } {
  switch (mode) {
    case 'order':
      return { shuffle: false, repeat: 'off' }
    case 'repeat-one':
      return { shuffle: false, repeat: 'one' }
    case 'shuffle':
      return { shuffle: true, repeat: 'all' }
    case 'repeat-all':
    default:
      return { shuffle: false, repeat: 'all' }
  }
}

/** 播放状态切片（不持久化的运行时状态）。 */
interface PlaybackState {
  /** 当前曲目。 */
  current: Track | null
  /** 播放队列（有序）。 */
  queue: Track[]
  /** 当前曲目在 queue 中的下标，-1 表示不在队列内。 */
  index: number
  /** 原始队列（未打乱），shuffle 关闭时恢复用。 */
  baseQueue: Track[]
  isPlaying: boolean
  /** 已播放秒数。 */
  position: number
  /** 总时长秒数。 */
  duration: number
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  /** 是否因版权/登录限制无法播放当前曲目。 */
  playError: string | null
  /** 当前播放错误是否由「需要登录」引起（决定提示条是否展示登录入口）。 */
  playErrorNeedLogin: boolean
  /** 触发播放错误的曲目所属源（用于把「登录解锁」引导到正确的源）。 */
  playErrorSource: MusicSource | null
  /** 是否处于缓冲中（网络停滞 / 数据未就绪）。 */
  buffering: boolean
  /** 是否展开全屏播放页。 */
  expanded: boolean
  /** 顺序播放模式下最后一首自然结束标记（用于 toggle 区分「结束停止」和「手动暂停」）。 */
  playbackEnded: boolean
}

interface PlaybackActions {
  /** 用一批曲目作为新队列并从指定下标开始播放。 */
  playTracks: (tracks: Track[], startIndex?: number) => void
  /** 在当前队列尾部追加曲目（不改变正在播放的曲目）。 */
  enqueue: (tracks: Track[]) => void
  /** 下一首（受 shuffle/repeat 影响）。 */
  next: () => void
  /** 上一首。 */
  prev: () => void
  /** 跳转到队列中指定下标。 */
  playIndex: (index: number) => void
  setPlaying: (v: boolean) => void
  toggle: () => void
  seek: (sec: number) => void
  setPosition: (sec: number) => void
  setDuration: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  cycleRepeat: () => void
  toggleShuffle: () => void
  /** 合并「随机 / 循环」为单一按钮：循环切换播放模式。 */
  cyclePlayMode: () => void
  clearQueue: () => void
  removeAt: (index: number) => void
  setExpanded: (v: boolean) => void
  setPlayError: (
    msg: string | null,
    needLogin?: boolean,
    source?: MusicSource | null,
  ) => void
  setPlaybackEnded: (v: boolean) => void
  setBuffering: (v: boolean) => void
}

export type PlayerStore = PlaybackState & PlaybackActions

/** 由下标数组生成打乱顺序（保留全部元素，Fisher–Yates）。 */
function shuffledIndexes(n: number, seedCurrent: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  // 让当前曲目排在打乱队列最前，避免「一开始就跳歌」
  const pos = arr.indexOf(seedCurrent)
  if (pos > 0) {
    arr.splice(pos, 1)
    arr.unshift(seedCurrent)
  }
  return arr
}

/** 根据 repeat 模式计算「自然结束」后的下一动作。 */
function advanceOnEnd(
  index: number,
  len: number,
  repeat: RepeatMode,
): number | null {
  if (len === 0) return null
  if (repeat === 'one') return index
  if (index + 1 < len) return index + 1
  if (repeat === 'all') return 0
  return null // 'off' 且是最后一首 -> 停止
}

export const usePlayer = create<PlayerStore>()(
  persist(
    (set, get) => ({
      current: null,
      queue: [],
      index: -1,
      baseQueue: [],
      isPlaying: false,
      position: 0,
      duration: 0,
      volume: 0.8,
      muted: false,
      repeat: 'all',
      shuffle: false,
      playError: null,
      playErrorNeedLogin: false,
      playErrorSource: null,
      buffering: false,
      expanded: false,
      playbackEnded: false,

      playTracks: (tracks, startIndex = 0) => {
        if (!tracks.length) return
        const base = [...tracks]
        const state = get()
        let queue = base
        let index = Math.min(Math.max(startIndex, 0), base.length - 1)
        if (state.shuffle) {
          // 以即将播放的曲目为种子重排
          const order = shuffledIndexes(base.length, index)
          queue = order.map((i) => base[i])
          index = 0
        }
        set({
          baseQueue: base,
          queue,
          index,
          current: queue[index] ?? null,
          isPlaying: true,
          position: 0,
          duration: 0,
          playError: null,
          playbackEnded: false,
        })
      },

      enqueue: (tracks) => {
        if (!tracks.length) return
        const state = get()
        if (!state.queue.length) {
          // 队列为空时直接作为新队列播放
          get().playTracks(tracks, 0)
          return
        }
        const baseQueue = [...state.baseQueue, ...tracks]
        if (state.shuffle) {
          // 打乱模式下把新曲目插入当前之后
          const queue = [...state.queue, ...tracks]
          set({ baseQueue, queue })
        } else {
          set({ baseQueue, queue: baseQueue })
        }
      },

      next: () => {
        const { queue, index, repeat } = get()
        if (!queue.length) return
        // shuffle 只是把队列**一次性重排**（见 shuffledIndexes），顺序游走即可：
        // 与自然结束的 advanceOnEnd 同构，保证「手动下一首」与「自然推进」一致且可预测。
        let nextIndex = index + 1
        if (nextIndex >= queue.length) {
          if (repeat === 'all') nextIndex = 0
          else {
            // 顺序播放到尾 → 停止，标记已结束
            set({ position: 0, isPlaying: false, playbackEnded: true })
            return
          }
        }
        set({
          index: nextIndex,
          current: queue[nextIndex] ?? null,
          position: 0,
          isPlaying: true,
          playError: null,
          playbackEnded: false,
        })
      },

      prev: () => {
        const { queue, index, position } = get()
        if (!queue.length) return
        // 已播放超过 3 秒则回到开头，符合主流播放器习惯。
        // 「回到开头」必须经 seekTo() 命令式驱动 <audio>：引擎对 position 是
        // 单向回写（rAF 每帧以 audio.currentTime 覆盖 store），直接 set position
        // 会在下一帧被真实播放位置覆盖，表现为点击后毫无反应。
        if (position > 3) {
          seekTo(0)
          return
        }
        // 同 next：顺序游走（shuffle 的重排已在队列里），越界回绕到末尾
        let prevIndex = index - 1
        if (prevIndex < 0) prevIndex = queue.length - 1
        set({
          index: prevIndex,
          current: queue[prevIndex] ?? null,
          position: 0,
          isPlaying: true,
          playError: null,
          playbackEnded: false,
        })
      },

      playIndex: (index) => {
        const { queue } = get()
        if (index < 0 || index >= queue.length) return
        set({
          index,
          current: queue[index],
          position: 0,
          isPlaying: true,
          playError: null,
          playbackEnded: false,
        })
      },

      setPlaying: (v) => set({ isPlaying: v }),
      toggle: () => {
        const { current, queue, index, isPlaying, playbackEnded } = get()
        // 顺序播放自然结束后点击播放 → 从第一首重新开始
        if (playbackEnded && !isPlaying && queue.length) {
          set({
            index: 0,
            current: queue[0],
            position: 0,
            isPlaying: true,
            playbackEnded: false,
            playError: null,
          })
          return
        }
        if (!current && queue.length) {
          set({
            index: index < 0 ? 0 : index,
            current: queue[index < 0 ? 0 : index],
            isPlaying: true,
          })
          return
        }
        set((s) => ({ isPlaying: !s.isPlaying }))
      },
      seek: (sec) => set({ position: Math.max(0, sec) }),
      setPosition: (sec) => set({ position: sec }),
      setDuration: (sec) => set({ duration: Number.isFinite(sec) ? sec : 0 }),
      setVolume: (v) =>
        set({ volume: Math.min(1, Math.max(0, v)), muted: v <= 0 }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),
      cycleRepeat: () =>
        set((s) => {
          const order: RepeatMode[] = ['off', 'all', 'one']
          const next = order[(order.indexOf(s.repeat) + 1) % order.length]
          return { repeat: next }
        }),
      toggleShuffle: () => {
        const { shuffle, baseQueue, current } = get()
        if (!shuffle) {
          // 开启打乱：基于当前曲目重排
          const seed = current
            ? baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
            : 0
          const order = shuffledIndexes(baseQueue.length, Math.max(seed, 0))
          const queue = order.map((i) => baseQueue[i])
          set({ shuffle: true, queue, index: 0, current: queue[0] ?? null })
        } else {
          // 关闭打乱：恢复原始顺序，并保持当前曲目
          const idx = current
            ? baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
            : 0
          set({ shuffle: false, queue: baseQueue, index: Math.max(idx, 0) })
        }
      },
      cyclePlayMode: () => {
        const { shuffle, repeat, baseQueue, current } = get()
        const mode = currentPlayMode(shuffle, repeat)
        const next =
          MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]
        const target = modeToState(next)

        // 仅当随机状态发生翻转时才需要重排 / 恢复队列，其余情况只改 repeat。
        if (target.shuffle === shuffle) {
          set({ repeat: target.repeat })
          return
        }
        if (target.shuffle) {
          // 进入随机：以当前曲目为种子重排
          const seed = current
            ? baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
            : 0
          const order = shuffledIndexes(baseQueue.length, Math.max(seed, 0))
          const queue = order.map((i) => baseQueue[i])
          set({
            shuffle: true,
            repeat: target.repeat,
            queue,
            index: 0,
            current: queue[0] ?? null,
          })
        } else {
          // 退出随机：恢复原始顺序并保持当前曲目
          const idx = current
            ? baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
            : 0
          set({
            shuffle: false,
            repeat: target.repeat,
            queue: baseQueue,
            index: Math.max(idx, 0),
          })
        }
      },
      clearQueue: () =>
        set({
          queue: [],
          baseQueue: [],
          index: -1,
          current: null,
          isPlaying: false,
          position: 0,
          duration: 0,
        }),
      removeAt: (index) => {
        const { queue, baseQueue, index: cur } = get()
        if (index < 0 || index >= queue.length) return
        const removed = queue[index]
        const newQueue = queue.filter((_, i) => i !== index)
        const newBase = baseQueue.filter((t) => keyOf(t) !== keyOf(removed))
        let newIndex = cur
        if (index < cur) newIndex = cur - 1
        else if (index === cur) {
          newIndex = Math.min(cur, newQueue.length - 1)
        }
        set({
          queue: newQueue,
          baseQueue: newBase,
          index: newIndex,
          current: newIndex >= 0 ? (newQueue[newIndex] ?? null) : null,
          ...(newQueue.length === 0
            ? { isPlaying: false, position: 0, duration: 0 }
            : {}),
        })
      },
      setExpanded: (v) => set({ expanded: v }),
      setPlayError: (msg, needLogin = false, source = null) =>
        set({
          playError: msg,
          playErrorNeedLogin: msg ? needLogin : false,
          playErrorSource: msg ? source : null,
        }),
      setPlaybackEnded: (v) => set({ playbackEnded: v }),
      setBuffering: (v) => set({ buffering: v }),
    }),
    {
      name: 'pterosaur-player',
      storage: createJSONStorage(() => localStorage),
      // 仅持久化「列表与偏好」，运行时播放进度/状态每次冷启动重置为暂停
      partialize: (s) => ({
        queue: s.queue,
        baseQueue: s.baseQueue,
        index: s.index,
        current: s.current,
        volume: s.volume,
        muted: s.muted,
        repeat: s.repeat,
        shuffle: s.shuffle,
        isPlaying: false,
        position: 0,
        duration: 0,
        playError: null,
        playErrorSource: null,
        expanded: false,
        playbackEnded: false,
      }),
    },
  ),
)

/** 由当前曲目派生音频源地址（同源代理，支持 Range）；`level` 为音质档位（缺省时由后端兜底）。 */
export function audioSrc(track: Track | null, level?: AudioLevel): string {
  return track ? streamUrlOf(track, level ? { level } : undefined) : ''
}

/** 供播放器组件使用的「自然结束」推进逻辑（导出以便测试）。 */
export { advanceOnEnd, shuffledIndexes }
