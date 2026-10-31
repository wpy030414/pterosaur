import { create } from 'zustand'
import type { AudioLevel, Track } from '@pterosaur/shared/types'
import {
  collectionState,
  removeOffline,
  saveTrackOffline,
  type CollectionState,
} from '../lib/offline.js'
import { downloadTrack, saveBlobAsFile } from '../lib/download.js'
import { audioKey, getSaved, hasSavedAudio } from '../lib/mediaCache.js'
import { registerCacheCleaner } from '../lib/cacheRegistry.js'

/**
 * 离线保存的**进度与状态**（仅运行时，不持久化；字节与来源在 IndexedDB）。
 *
 * 播放过的曲目自动保存（`saveOnPlay`），界面不再提供「保存离线」开关；本 store 负责
 * 「当前曲是否已保存」的查询与后台保存的编排，真正的下载与写 IDB 在 `lib/offline.ts`。
 */
export type TrackSaveState = 'none' | 'saved' | 'saving'

export interface OfflineState {
  /** 当前曲的保存状态（由 `refreshTrack` 查询；播放即保存后随之变为 `saved`）。 */
  trackState: TrackSaveState
  /** 最近一次结果说明（如「已保存 12 首，4 首需登录」），`null` 无。 */
  lastMessage: string | null
  /** 最近一次错误。 */
  error: string | null
}

export interface OfflineActions {
  /** 重查某曲是否已保存。 */
  refreshTrack: (track: Track | null, level: AudioLevel) => Promise<void>
  /** 播放即保存：强制把该曲写入离线保存，**不**改动按钮显示的状态。 */
  saveOnPlay: (track: Track, level: AudioLevel) => void
  /** 删除某曲的离线保存。 */
  removeTrack: (track: Track) => Promise<void>
  /**
   * 导出某曲到本机（浏览器下载）：**优先用已保存的字节**，没保存过才走网络。
   * 这样「保存离线 → 导出」在断网时也能用，且不会白下一遍。
   */
  exportTrack: (track: Track, level: AudioLevel) => Promise<void>
  /** 集合整体状态（用于歌单 / 专辑页的按钮）。 */
  stateOf: (
    tracks: readonly Track[],
    level: AudioLevel,
  ) => Promise<CollectionState>
  /** 清空说明 / 错误。 */
  clearMessage: () => void
}

export const useOffline = create<OfflineState & OfflineActions>()((set) => ({
  trackState: 'none',
  lastMessage: null,
  error: null,

  refreshTrack: async (track, level) => {
    if (!track) {
      set({ trackState: 'none' })
      return
    }
    const saved = await hasSavedAudio(track.source, track.id, level)
    set({ trackState: saved ? 'saved' : 'none' })
  },

  saveOnPlay: (track, level) => {
    // 后台进行：失败**静默**（离线播放届时会给出明确提示）；状态灯由 refreshTrack 决定
    void saveTrackOffline(track, level).catch(() => {})
  },

  removeTrack: async (track) => {
    await removeOffline([track])
    set({ trackState: 'none' })
  },

  exportTrack: async (track, level) => {
    try {
      const saved = await getSaved(audioKey(track.source, track.id, level))
      if (saved) saveBlobAsFile(track, saved.blob, saved.meta.mime)
      else await downloadTrack(track, level)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  stateOf: (tracks, level) => collectionState(tracks, level),

  clearMessage: () => set({ lastMessage: null, error: null }),
}))

// 登录 / 退出清缓存时复位状态（字节已被清空，界面上不应再显示「已保存」）
registerCacheCleaner(() => useOffline.getState().clearMessage())
