import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RepeatMode, Track } from '@pterosaur/shared/types'
import { playerQueueStorage } from '../lib/playerQueueStorage.js'

/** 播放模式：把「随机」与「循环」合并为单一 UI 概念，供播放条的合并按钮循环切换。 */
export type PlayMode = 'order' | 'repeat-all' | 'repeat-one' | 'shuffle'

/** 合并模式的循环顺序。 */
export const MODE_CYCLE: PlayMode[] = [
  'order',
  'repeat-all',
  'repeat-one',
  'shuffle',
]

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
export function modeToState(mode: PlayMode): {
  shuffle: boolean
  repeat: RepeatMode
} {
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

/**
 * 队列与播放偏好（**持久化**）。
 *
 * 只放「重开后仍应存在」的数据：队列 / 下标 / 音量 / 循环与随机。播放瞬时状态
 * （进度、缓冲、错误）在 `store/playbackSession`，全屏开合在 `store/playerUi`。
 * 三者分开后，rAF 每帧的进度写入不会再触发队列的整份序列化。
 *
 * 本 store 只做**纯数据移动**（洗牌、数组运算）；凡是「改队列的同时要改当前曲目 /
 * 播放态」的动作（`next` / `prev` / `removeAt` …）由 `store/player.ts` 的命令层编排，
 * 这样三个 store 之间**不存在互相 import**。
 */
export interface QueueState {
  /** 播放队列（有序，已按 shuffle 重排）。 */
  queue: Track[]
  /** 当前曲目在 queue 中的下标，-1 表示不在队列内。 */
  index: number
  /** 原始队列（未打乱），shuffle 关闭时恢复用。 */
  baseQueue: Track[]
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  /**
   * 上次播放到的曲目（`source:id`）。刷新后据此把播放会话恢复到队列里同一首
   * （`index` 可能因队列随后的增删而指向别处）；只作恢复锚点，不参与查重。
   */
  lastKey: string | null
}

export interface QueueActions {
  /** 直接替换队列的三个数据字段（调用方负责与 session 对齐）。 */
  setQueue: (patch: Pick<QueueState, 'queue' | 'baseQueue' | 'index'>) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  cycleRepeat: () => void
}

export type PlayerQueueStore = QueueState & QueueActions

/** 由下标数组生成打乱顺序（保留全部元素，Fisher–Yates）。 */
export function shuffledIndexes(n: number, seedCurrent: number): number[] {
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
export function advanceOnEnd(
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

/** 一组曲目与起始下标：按 shuffle 是否需要重排，产出 (queue, baseQueue, index)。 */
export function buildQueue(
  base: Track[],
  startIndex: number,
  shuffle: boolean,
): { baseQueue: Track[]; queue: Track[]; index: number } {
  if (!shuffle) return { baseQueue: base, queue: base, index: startIndex }
  const order = shuffledIndexes(base.length, startIndex)
  return { baseQueue: base, queue: order.map((i) => base[i]), index: 0 }
}

/**
 * 打乱模式开关时重算队列：开启则以 `current` 为种子重排；关闭则恢复 `baseQueue`。

 * 返回新的 queue 与 index；`current` 保持不变（由调用方按 index 对齐）。
 */
export function reorderForShuffle(
  baseQueue: Track[],
  currentIndex: number,
  enableShuffle: boolean,
): { queue: Track[]; index: number } {
  if (enableShuffle) {
    const order = shuffledIndexes(baseQueue.length, Math.max(currentIndex, 0))
    return { queue: order.map((i) => baseQueue[i]), index: 0 }
  }
  return { queue: baseQueue, index: Math.max(currentIndex, 0) }
}

export const usePlayerQueue = create<PlayerQueueStore>()(
  persist(
    (set) => ({
      queue: [],
      index: -1,
      baseQueue: [],
      volume: 0.8,
      muted: false,
      repeat: 'all',
      shuffle: false,
      lastKey: null,

      setQueue: (patch) => set(patch),
      // 音量降到 0 视为静音，与播放条的音量图标一致
      setVolume: (v) =>
        set({ volume: Math.min(1, Math.max(0, v)), muted: v <= 0 }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),
      cycleRepeat: () =>
        set((s) => {
          const order: RepeatMode[] = ['off', 'all', 'one']
          const next = order[(order.indexOf(s.repeat) + 1) % order.length]
          return { repeat: next }
        }),
    }),
    {
      name: 'pterosaur-player',
      storage: playerQueueStorage,
      // IDB 的 structured clone 不能克隆函数：只列数据字段
      partialize: (s): QueueState => ({
        queue: s.queue,
        index: s.index,
        baseQueue: s.baseQueue,
        volume: s.volume,
        muted: s.muted,
        repeat: s.repeat,
        shuffle: s.shuffle,
        lastKey: s.lastKey,
      }),
      // hydration 由 main.tsx 在首帧前显式完成（IDB 读取是异步的）
      skipHydration: true,
    },
  ),
)
