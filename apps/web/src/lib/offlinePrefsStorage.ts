import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { LIBRARY_STORE, idbDelete, idbGet, idbPut } from './idb.js'

/**
 * 离线保存的**偏好**存储（持久化到 IndexedDB，与资料库同一个通用键值 store）。
 *
 * 只存「用户要不要自动预取下一首」这类偏好；离线保存的字节与来源在 `media/offlineMeta`，
 * 播放进度 / 错误等瞬时态不进任何持久化（见 ADR-011 的 partialize 约定）。
 */
export interface OfflinePrefs {
  /** 是否在播放时自动预取队列相邻曲目（默认开；省流网络下由调度器自行跳过）。 */
  autoPrefetch: boolean
}

export const OFFLINE_PREFS_KEY = 'pterosaur-offline'

export const offlinePrefsStorage: PersistStorage<OfflinePrefs> = {
  async getItem(name): Promise<StorageValue<OfflinePrefs> | null> {
    const value = await idbGet<StorageValue<OfflinePrefs>>(LIBRARY_STORE, name)
    return value ?? null
  },
  setItem: (name, value) => idbPut(LIBRARY_STORE, value, name),
  removeItem: (name) => idbDelete(LIBRARY_STORE, name),
}
