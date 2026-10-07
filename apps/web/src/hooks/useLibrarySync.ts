import { useEffect } from 'react'
import { useAuth, activeSource } from '../store/auth.js'
import { useSync } from '../store/sync.js'
import { startEventStream, startLibrarySync, syncOnEntry } from '../lib/sync.js'

/**
 * 挂载 library 云同步引擎（在 `App` 顶层调用一次）。
 *
 * 「激活」条件：开关已开启 **且** 已登录 **且** 活动账号与开启时绑定的一致（单活动账号，锚点 `<源>:<账号id>`）。
 * 激活即进入一次同步（**云端权威**：云端覆盖本地，云端为空则以本地为准并上传），随后：
 * - 订阅本地变更做防抖推送；
 * - 打开 SSE 实时通道，接收其它设备的更新；
 * 失活 / 卸载时全部退订。换账号会因绑定不符自动失活。
 */
export function useLibrarySync(): void {
  const status = useAuth((s) => s.status)
  const enabled = useSync((s) => s.enabled)
  const boundSource = useSync((s) => s.source)
  const boundAccountId = useSync((s) => s.accountId)

  const source = activeSource(status)
  const accountId = source ? status[source]?.userId : undefined

  const active =
    enabled &&
    source != null &&
    accountId != null &&
    source === boundSource &&
    accountId === boundAccountId

  useEffect(() => {
    if (!active) return
    void syncOnEntry().catch((e) => console.warn('[sync] 首次同步失败', e))
    const stopPush = startLibrarySync()
    const stopSse = startEventStream()
    return () => {
      stopPush()
      stopSse()
    }
  }, [active])
}
