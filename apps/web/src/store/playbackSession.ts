import { create } from 'zustand'
import type { MusicSource, Track } from '@pterosaur/shared/types'

/**
 * 播放**瞬时**状态（不持久化）。
 *
 * 与队列分开的原因：`position` 由 rAF 逐帧回写，`buffering` / `isPlaying` 高频翻转。
 * 留在一个持久化 store 里会让每帧都触发整份队列的序列化。
 */
export interface PlaybackSessionState {
  /** 当前曲目。 */
  current: Track | null
  isPlaying: boolean
  /** 已播放秒数。 */
  position: number
  /** 总时长秒数。 */
  duration: number
  /** 是否因版权/登录限制无法播放当前曲目。 */
  playError: string | null
  /** 当前播放错误是否由「需要登录」引起（决定提示条是否展示登录入口）。 */
  playErrorNeedLogin: boolean
  /** 触发播放错误的曲目所属源（用于把「登录解锁」引导到正确的源）。 */
  playErrorSource: MusicSource | null
  /** 是否处于缓冲中（网络停滞 / 数据未就绪）。 */
  buffering: boolean
  /** 顺序播放模式下最后一首自然结束标记（用于 toggle 区分「结束停止」和「手动暂停」）。 */
  playbackEnded: boolean
}

export interface PlaybackSessionActions {
  /** 切到新曲目并重置进度 / 错误（队列推进的公共出口）。 */
  startTrack: (track: Track | null) => void
  setPlaying: (v: boolean) => void
  seek: (sec: number) => void
  setPosition: (sec: number) => void
  setDuration: (sec: number) => void
  setPlayError: (
    msg: string | null,
    needLogin?: boolean,
    source?: MusicSource | null,
  ) => void
  setPlaybackEnded: (v: boolean) => void
  setBuffering: (v: boolean) => void
  /** 清空当前曲目（队列被清空时）。 */
  reset: () => void
}

export type PlaybackSessionStore = PlaybackSessionState & PlaybackSessionActions

const DEFAULT_STATE: PlaybackSessionState = {
  current: null,
  isPlaying: false,
  position: 0,
  duration: 0,
  playError: null,
  playErrorNeedLogin: false,
  playErrorSource: null,
  buffering: false,
  playbackEnded: false,
}

export const usePlaybackSession = create<PlaybackSessionStore>()((set) => ({
  ...DEFAULT_STATE,

  startTrack: (track) =>
    set({
      current: track,
      isPlaying: true,
      position: 0,
      duration: 0,
      playError: null,
      playbackEnded: false,
    }),
  setPlaying: (v) => set({ isPlaying: v }),
  seek: (sec) => set({ position: Math.max(0, sec) }),
  setPosition: (sec) => set({ position: sec }),
  setDuration: (sec) => set({ duration: Number.isFinite(sec) ? sec : 0 }),
  setPlayError: (msg, needLogin = false, source = null) =>
    set({
      playError: msg,
      playErrorNeedLogin: msg ? needLogin : false,
      playErrorSource: msg ? source : null,
    }),
  setPlaybackEnded: (v) => set({ playbackEnded: v }),
  setBuffering: (v) => set({ buffering: v }),
  reset: () => set({ ...DEFAULT_STATE }),
}))

/** 只读地取当前曲目（避免组件订阅整个 store）。 */
export const currentTrack = (): Track | null =>
  usePlaybackSession.getState().current
