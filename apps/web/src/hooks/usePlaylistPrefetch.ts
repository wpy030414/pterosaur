import { useEffect } from 'react'
import { keyOf } from '@pterosaur/shared/types'
import { usePlayerQueue } from '../store/playerQueue.js'
import { usePlaybackSession } from '../store/playbackSession.js'
import { useOfflinePrefs } from '../store/offlinePrefs.js'
import { useSettings } from '../store/settings.js'
import { audioEl } from './audioElement.js'
import {
  canPrefetch,
  createPrefetchScheduler,
  prefetchTargets,
  type ConnectionLike,
} from '../lib/prefetch.js'

/**
 * 队列**离线预取**：当前曲 / 队列 / 档位变化时，重排「前后各 1 首」的下载进离线保存
 * （见 ADR-060；距当前曲 ±1 已够覆盖「下一首」，且不给用户存储多加负担）。
 *
 * 只订阅 `current` / `queue` / `index` / `level` / `buffering`（**不订阅 `position`**，否则会被
 * 约 20Hz 的进度回写反复触发）。`buffering` 入依赖既作门控输入，也保证缓冲结束后能重新排程
 * （已完成的靠去重表跳过）。`readyState` 高频变化故不进依赖——由 `gate` 现场读取。
 */

function getConnection(): ConnectionLike | undefined {
  return (navigator as Navigator & { connection?: ConnectionLike }).connection
}

// 模块级单例调度器（与 lyricCache 的模块级状态风格一致）
const scheduler = createPrefetchScheduler({
  gate: () =>
    canPrefetch({
      online: navigator.onLine,
      connection: getConnection(),
      buffering: usePlaybackSession.getState().buffering,
      readyState: audioEl.current?.readyState ?? 0,
    }),
})

export function usePlaylistPrefetch(): void {
  const current = usePlaybackSession((s) => s.current)
  const queue = usePlayerQueue((s) => s.queue)
  const index = usePlayerQueue((s) => s.index)
  const buffering = usePlaybackSession((s) => s.buffering)
  const level = useSettings((s) => s.level)
  const autoPrefetch = useOfflinePrefs((s) => s.autoPrefetch)
  const currentKey = current ? keyOf(current) : ''

  useEffect(() => {
    if (!autoPrefetch) {
      scheduler.cancel()
      return
    }
    const targets = prefetchTargets(queue, index)
    if (!targets.length) {
      scheduler.cancel()
      return
    }
    scheduler.schedule(targets, level)
    return () => scheduler.cancel()
  }, [currentKey, queue, index, level, buffering, autoPrefetch])
}
