import type { PersistStorage, StorageValue } from 'zustand/middleware'
import type { QueueState } from '../store/playerQueue.js'
import { LIBRARY_STORE, idbDelete, idbGet, idbPut } from './idb.js'
import { coalesceWrites } from './coalesceWrites.js'

/**
 * 播放队列 store 的 IndexedDB 持久化适配器（与 `libraryStorage` 同构）。
 *
 * 队列里每条都是完整的 `Track`，动辄上百首——放 localStorage 既有 5MB 配额风险
 * （写满时 persist 会静默失败），也每次全量 JSON 序列化。IDB 用 structured clone
 * 直接存对象，配合 persist 的 `partialize` 只落数据字段。
 *
 * **一次性迁移**：旧版 `pterosaur-player` 键只保留队列与偏好，播放态字段一律丢弃
 * （旧 partialize 本就把它们重置成初始值）。
 */

/** persist 的 `name`（IDB 里的 key）；沿用旧键名，便于迁移后继续识别。 */
const STORE_KEY = 'pterosaur-player'
/** 旧版 localStorage 键名（迁移来源）。 */
const LEGACY_KEY = 'pterosaur-player'

/** 旧版 localStorage 里可能存在的字段（只取这里列出的）。 */
interface LegacyPlayerState {
  queue?: unknown
  baseQueue?: unknown
  index?: unknown
  current?: unknown
  volume?: unknown
  muted?: unknown
  repeat?: unknown
  shuffle?: unknown
}

function isStorageValue(v: unknown): v is StorageValue<unknown> {
  if (!v || typeof v !== 'object') return false
  const state = (v as { state?: unknown }).state
  return !!state && typeof state === 'object'
}

/** 从旧版 localStorage 载荷中挑出队列与偏好字段。 */
function migrateLegacy(raw: unknown): QueueState | null {
  if (!isStorageValue(raw)) return null
  const s = raw.state as LegacyPlayerState
  if (!Array.isArray(s.queue) || !Array.isArray(s.baseQueue)) return null
  return {
    queue: s.queue as QueueState['queue'],
    baseQueue: s.baseQueue as QueueState['baseQueue'],
    index: typeof s.index === 'number' ? s.index : -1,
    volume: typeof s.volume === 'number' ? s.volume : 0.8,
    muted: typeof s.muted === 'boolean' ? s.muted : false,
    repeat: (s.repeat ?? 'all') as QueueState['repeat'],
    shuffle: typeof s.shuffle === 'boolean' ? s.shuffle : false,
  }
}

const base: PersistStorage<QueueState> = {
  async getItem(name) {
    // 1) 一次性迁移：旧 localStorage -> IDB，并删除旧键（键的存亡即幂等标记）
    if (typeof localStorage !== 'undefined') {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) {
        let migrated: QueueState | null = null
        try {
          migrated = migrateLegacy(JSON.parse(legacy))
        } catch {
          /* 脏数据：忽略 */
        }
        localStorage.removeItem(LEGACY_KEY)
        if (migrated) {
          const value: StorageValue<QueueState> = {
            state: migrated,
            version: 0,
          }
          await idbPut(LIBRARY_STORE, value, name)
          return value
        }
      }
    }

    // 2) 常规读取
    const value = await idbGet<StorageValue<QueueState>>(LIBRARY_STORE, name)
    return value ?? null
  },

  setItem: (name, value) => idbPut(LIBRARY_STORE, value, name),
  removeItem: (name) => idbDelete(LIBRARY_STORE, name),
}

/** 已套用写合并的队列存储。 */
export const playerQueueStorage = coalesceWrites(base)

/** 立即把待写入的队列数据落盘（供测试 / 页面隐藏时调用）。 */
export const flushPlayerQueueWrites = playerQueueStorage.flush

/** persist 使用的键名（导出供测试断言）。 */
export const PLAYER_QUEUE_STORE_KEY = STORE_KEY
