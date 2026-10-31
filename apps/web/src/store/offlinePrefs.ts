import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  OFFLINE_PREFS_KEY,
  offlinePrefsStorage,
  type OfflinePrefs,
} from '../lib/offlinePrefsStorage.js'

/**
 * 离线保存偏好（持久化）。
 *
 * 目前只有一项：播放时是否自动预取队列相邻曲目——它决定「随手听过的歌」会不会悄悄
 * 占掉用户的存储，所以给了开关。默认开；省流网络下调度器仍会自行跳过（见 `lib/prefetch.ts`）。
 */
export const useOfflinePrefs = create<
  OfflinePrefs & { setAutoPrefetch: (v: boolean) => void }
>()(
  persist(
    (set) => ({
      autoPrefetch: true,
      setAutoPrefetch: (autoPrefetch) => set({ autoPrefetch }),
    }),
    {
      name: OFFLINE_PREFS_KEY,
      storage: offlinePrefsStorage,
      partialize: (s): OfflinePrefs => ({ autoPrefetch: s.autoPrefetch }),
    },
  ),
)
