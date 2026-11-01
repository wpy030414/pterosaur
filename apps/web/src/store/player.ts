import type { RepeatMode, Track } from '@pterosaur/shared/types'
import { keyOf, streamUrlOf, type AudioLevel } from '@pterosaur/shared/types'
import { seekTo } from '../hooks/audioElement.js'
import {
  MODE_CYCLE,
  advanceOnEnd,
  buildQueue,
  currentPlayMode,
  modeToState,
  reorderForShuffle,
  shuffledIndexes,
  usePlayerQueue,
  type PlayMode,
} from './playerQueue.js'
import { usePlaybackSession } from './playbackSession.js'

/**
 * 播放的**命令层**：凡是「改队列的同时要改当前曲目 / 播放态」的动作都在这里，
 * 一次性编排 `usePlayerQueue` 与 `usePlaybackSession`，因此这两个 store 之间
 * 不需要互相 import。
 *
 * 无副作用的纯数据函数（洗牌、游走、模式换算）随队列一起放在 `playerQueue.ts`，
 * 此处再导出以保持既有导入路径不变。
 */

const queue = () => usePlayerQueue.getState()
const session = () => usePlaybackSession.getState()

export interface PlayerCommands {
  /** 用一批曲目作为新队列并从指定下标开始播放。 */
  playTracks: (tracks: Track[], startIndex?: number) => void
  /** 在当前队列尾部追加曲目（不改变正在播放的曲目）。 */
  enqueue: (tracks: Track[]) => void
  /** 下一首（受 repeat 影响；shuffle 的重排已在队列里）。 */
  next: () => void
  /** 上一首。 */
  prev: () => void
  /** 跳转到队列中指定下标。 */
  playIndex: (index: number) => void
  /** 播放/暂停；顺序播放自然结束后再次播放则从头开始。 */
  toggle: () => void
  /** 合并「随机 / 循环」为单一按钮：循环切换播放模式。 */
  cyclePlayMode: () => void
  /** 开 / 关随机（重排或恢复队列，当前曲目不变）。 */
  toggleShuffle: () => void
  clearQueue: () => void
  removeAt: (index: number) => void
}

/** 把队列下标推进到 `nextIndex` 并开始播放该曲。 */
function goTo(nextIndex: number): void {
  const { queue: list } = queue()
  const track = list[nextIndex] ?? null
  usePlayerQueue.setState({
    index: nextIndex,
    lastKey: track ? keyOf(track) : null,
  })
  session().startTrack(track)
}

export const playerCommands: PlayerCommands = {
  playTracks: (tracks, startIndex = 0) => {
    if (!tracks.length) return
    const base = [...tracks]
    const start = Math.min(Math.max(startIndex, 0), base.length - 1)
    const built = buildQueue(base, start, queue().shuffle)
    const track = built.queue[built.index] ?? null
    usePlayerQueue.getState().setQueue(built)
    usePlayerQueue.setState({ lastKey: track ? keyOf(track) : null })
    session().startTrack(track)
    session().setDuration(0)
  },

  enqueue: (tracks) => {
    if (!tracks.length) return
    const s = queue()
    if (!s.queue.length) {
      playerCommands.playTracks(tracks, 0)
      return
    }
    const baseQueue = [...s.baseQueue, ...tracks]
    // 打乱模式下把新曲目插入当前之后；顺序模式下新队列即 baseQueue
    const list = s.shuffle ? [...s.queue, ...tracks] : baseQueue
    usePlayerQueue
      .getState()
      .setQueue({ baseQueue, queue: list, index: s.index })
  },

  next: () => {
    const { queue: list, index, repeat } = queue()
    if (!list.length) return
    // shuffle 只是把队列**一次性重排**（见 shuffledIndexes），顺序游走即可：
    // 与自然结束的 advanceOnEnd 同构，保证「手动下一首」与「自然推进」一致且可预测。
    let nextIndex = index + 1
    if (nextIndex >= list.length) {
      if (repeat === 'all') nextIndex = 0
      else {
        // 顺序播放到尾 → 停止，标记已结束
        session().seek(0)
        session().setPlaying(false)
        session().setPlaybackEnded(true)
        return
      }
    }
    goTo(nextIndex)
  },

  prev: () => {
    const { queue: list, index } = queue()
    if (!list.length) return
    // 已播放超过 3 秒则回到开头，符合主流播放器习惯。
    // 「回到开头」必须经 seekTo() 命令式驱动 <audio>：引擎对 position 是
    // 单向回写（rAF 每帧以 audio.currentTime 覆盖 store），直接 set position
    // 会在下一帧被真实播放位置覆盖，表现为点击后毫无反应。
    if (session().position > 3) {
      seekTo(0)
      return
    }
    // 同 next：顺序游走（shuffle 的重排已在队列里），越界回绕到末尾
    let prevIndex = index - 1
    if (prevIndex < 0) prevIndex = list.length - 1
    goTo(prevIndex)
  },

  playIndex: (index) => {
    const { queue: list } = queue()
    if (index < 0 || index >= list.length) return
    goTo(index)
  },

  toggle: () => {
    const { queue: list, index } = queue()
    const { current, isPlaying, playbackEnded } = session()
    // 顺序播放自然结束后点击播放 → 从第一首重新开始
    if (playbackEnded && !isPlaying && list.length) {
      usePlayerQueue.setState({ index: 0 })
      session().startTrack(list[0] ?? null)
      return
    }
    if (!current && list.length) {
      const at = index < 0 ? 0 : index
      usePlayerQueue.setState({ index: at })
      session().startTrack(list[at] ?? null)
      return
    }
    session().setPlaying(!isPlaying)
  },

  cyclePlayMode: () => {
    const s = queue()
    const { current } = session()
    const mode = currentPlayMode(s.shuffle, s.repeat)
    const target = modeToState(
      MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length] ??
        'repeat-all',
    )

    // 仅当随机状态发生翻转时才需要重排 / 恢复队列，其余情况只改 repeat。
    if (target.shuffle === s.shuffle) {
      usePlayerQueue.setState({ repeat: target.repeat })
      return
    }
    const currentIndex = current
      ? s.baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
      : 0
    const { queue: list, index } = reorderForShuffle(
      s.baseQueue,
      currentIndex,
      target.shuffle,
    )
    usePlayerQueue.setState({
      shuffle: target.shuffle,
      repeat: target.repeat,
      queue: list,
      index,
    })
    // 当前曲目保持可见（索引换了位置，曲目本身不变）
    usePlaybackSession.setState({ current: list[index] ?? current })
  },

  toggleShuffle: () => {
    const s = queue()
    const { current } = session()
    const enable = !s.shuffle
    const currentIndex = current
      ? s.baseQueue.findIndex((t) => keyOf(t) === keyOf(current))
      : 0
    const { queue: list, index } = reorderForShuffle(
      s.baseQueue,
      currentIndex,
      enable,
    )
    usePlayerQueue.setState({ shuffle: enable, queue: list, index })
    usePlaybackSession.setState({ current: list[index] ?? current })
  },

  clearQueue: () => {
    usePlayerQueue.getState().setQueue({ queue: [], baseQueue: [], index: -1 })
    usePlayerQueue.setState({ lastKey: null })
    session().reset()
  },

  removeAt: (index) => {
    const s = queue()
    const cur = session().current
    const { queue: list, baseQueue } = s
    if (index < 0 || index >= list.length) return
    const removed = list[index]
    const removedKey = removed ? keyOf(removed) : null
    const newQueue = list.filter((_, i) => i !== index)
    const newBase = removedKey
      ? baseQueue.filter((t) => keyOf(t) !== removedKey)
      : baseQueue
    let newIndex = s.index
    if (index < s.index) newIndex = s.index - 1
    else if (index === s.index)
      newIndex = Math.min(s.index, newQueue.length - 1)

    usePlayerQueue.getState().setQueue({
      queue: newQueue,
      baseQueue: newBase,
      index: newIndex,
    })
    if (newQueue.length === 0) {
      session().reset()
      return
    }
    const nextCurrent = newIndex >= 0 ? (newQueue[newIndex] ?? null) : null
    // 只有「被删的正是当前曲目」才切换当前曲；否则保持播放中的曲目不动
    if (removedKey && cur && keyOf(cur) === removedKey) {
      session().startTrack(nextCurrent)
    } else {
      usePlaybackSession.setState({ current: nextCurrent })
    }
  },
}

/**
 * 刷新后恢复播放会话的「当前曲目」（**不自动播放**）。
 *
 * 队列是持久化的，而播放瞬时态不持久化——以前重开后播放条空空如也，点播放却从队列恢复出
 * 上一首。这里按 `lastKey` 把 `current` 对齐回上次播放的那首（队列随后的增删会让 `index`
 * 漂移，故不按下标），由 `main.tsx` 在队列 hydration 之后调用。
 */
export function restoreSession(): void {
  const s = queue()
  if (!s.queue.length) return
  let at = s.lastKey ? s.queue.findIndex((t) => keyOf(t) === s.lastKey) : -1
  if (at < 0) at = s.index >= 0 && s.index < s.queue.length ? s.index : 0
  const track = s.queue[at]
  if (!track) return
  if (at !== s.index) usePlayerQueue.setState({ index: at })
  // 只恢复「停在谁身上」；刷新后不自动续播，播放由用户发起。不是「换曲」：引擎此时
  // 尚未加载任何源，点播放会走正常的起播路径
  usePlaybackSession.setState({ current: track, isPlaying: false })
}

/** 由当前曲目派生音频源地址（同源代理，支持 Range）；`level` 为音质档位（缺省时由后端兜底）。 */
export function audioSrc(track: Track | null, level?: AudioLevel): string {
  return track ? streamUrlOf(track, level ? { level } : undefined) : ''
}

export {
  MODE_CYCLE,
  advanceOnEnd,
  buildQueue,
  currentPlayMode,
  modeToState,
  reorderForShuffle,
  shuffledIndexes,
  usePlayerQueue,
  usePlaybackSession,
  type PlayMode,
  type RepeatMode,
}
