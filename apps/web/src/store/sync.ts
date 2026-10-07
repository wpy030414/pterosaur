import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MusicSource } from '@pterosaur/shared/types'

/**
 * library 云同步的**开关与记账**（本地持久化）。
 *
 * 单活动账号模型下，锚点是**活动账号** `<source>:<accountId>`（见 ADR-028）：
 * - `enabled`：云同步是否开启（**登录后默认开启**，见 `finishQrLogin`）。
 * - `source` / `accountId`：开启时绑定的活动账号；与当前活动账号不符则自动失活。
 * - `rev`：本机已知的云端版本号（服务端指派），用于忽略自己推送的 SSE 回声。
 *
 * 仅这几项入 localStorage；引擎的「应用云端数据中」抑制位是运行期状态，放在 `lib/sync.ts` 模块级变量。
 */
interface SyncState {
  enabled: boolean
  source?: MusicSource
  accountId?: string
  rev: number
}

interface SyncActions {
  setEnabled: (enabled: boolean) => void
  /** 开启并绑定当前活动账号。 */
  enable: (source?: MusicSource, accountId?: string) => void
  /** 关闭同步（不删云端副本）。 */
  disable: () => void
  /** 推进本机已知的云端版本号。 */
  touch: (rev: number) => void
}

export type SyncStore = SyncState & SyncActions

export const useSync = create<SyncStore>()(
  persist(
    (set) => ({
      enabled: false,
      source: undefined,
      accountId: undefined,
      rev: 0,

      setEnabled: (enabled) => set({ enabled }),
      enable: (source, accountId) => set({ enabled: true, source, accountId }),
      disable: () => set({ enabled: false }),
      touch: (rev) => set({ rev }),
    }),
    {
      name: 'pterosaur-sync',
      partialize: (s) => ({
        enabled: s.enabled,
        source: s.source,
        accountId: s.accountId,
        rev: s.rev,
      }),
    },
  ),
)
