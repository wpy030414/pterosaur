import { create } from 'zustand'
import type { AudioLevel, Track } from '@pterosaur/shared/types'
import {
  collectionState,
  listOffline,
  removeOffline,
  saveTrackOffline,
  saveTracks,
  type CollectionState,
  type SaveProgress,
} from '../lib/offline.js'
import { downloadTrack, saveBlobAsFile } from '../lib/download.js'
import { audioKey, getSaved } from '../lib/mediaCache.js'
import { registerCacheCleaner } from '../lib/cacheRegistry.js'

/**
 * 离线保存的**进度与状态**（仅运行时，不持久化；字节与来源在 IndexedDB）。
 *
 * 播放条按钮 / 设置弹窗据此显示：当前曲是否已保存、集合保存进度、失败数。
 * 所有写操作都委托给 `lib/offline.ts`（真下载 + 写 IDB），本 store 只做状态编排。
 */
export type TrackSaveState = 'none' | 'saved' | 'saving'

export interface OfflineState {
  /** 当前曲的保存状态（由 `refreshTrack` 查询、由保存动作乐观更新）。 */
  trackState: TrackSaveState
  /** 正在保存的集合进度；`null` 表示空闲。 */
  progress: SaveProgress | null
  /** 最近一次结果说明（如「已保存 12 首，4 首需登录」），`null` 无。 */
  lastMessage: string | null
  /** 最近一次错误。 */
  error: string | null
}

export interface OfflineActions {
  /** 重查某曲是否已保存。 */
  refreshTrack: (track: Track | null, level: AudioLevel) => Promise<void>
  /** 保存单曲（幂等）。 */
  saveTrack: (track: Track, level: AudioLevel) => Promise<void>
  /** 保存一个集合（歌单 / 专辑 / 我喜欢）。 */
  saveAll: (tracks: readonly Track[], level: AudioLevel) => Promise<void>
  /** 取消集合保存（已完成的保留）。 */
  cancel: () => void
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

/** 正在跑的集合保存；新的一次会中止旧的。 */
let current: AbortController | null = null

export const useOffline = create<OfflineState & OfflineActions>()(
  (set, get) => ({
    trackState: 'none',
    progress: null,
    lastMessage: null,
    error: null,

    refreshTrack: async (track, level) => {
      if (!track) {
        set({ trackState: 'none' })
        return
      }
      const items = await listOffline()
      const saved = items.some(
        (i) =>
          i.source === track.source &&
          i.trackId === track.id &&
          i.level === level,
      )
      set({ trackState: saved ? 'saved' : 'none' })
    },

    saveTrack: async (track, level) => {
      set({ trackState: 'saving', error: null })
      const outcome = await saveTrackOffline(track, level)
      if (outcome.kind === 'saved') {
        set({ trackState: 'saved' })
      } else {
        set({
          trackState: 'none',
          error:
            outcome.kind === 'needLogin'
              ? '该曲目需登录后才能保存'
              : outcome.message,
        })
      }
    },

    saveAll: async (tracks, level) => {
      current?.abort()
      current = new AbortController()
      const signal = current.signal
      set({
        progress: {
          total: tracks.length,
          done: 0,
          saved: 0,
          needLogin: 0,
          failed: 0,
        },
        error: null,
      })
      const p = await saveTracks(
        tracks,
        level,
        (snap) => set({ progress: snap }),
        signal,
      )
      set({
        progress: null,
        lastMessage:
          `已保存 ${p.saved} 首` +
          (p.needLogin ? `，${p.needLogin} 首需登录` : '') +
          (p.failed ? `，${p.failed} 首失败` : ''),
      })
    },

    cancel: () => {
      current?.abort()
      current = null
      set({ progress: null })
      get().clearMessage()
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
  }),
)

// 登录 / 退出清缓存时复位状态（字节已被清空，界面上不应再显示「已保存」）
registerCacheCleaner(() => useOffline.getState().clearMessage())
