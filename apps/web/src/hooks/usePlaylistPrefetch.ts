import { useEffect } from 'react'
import { keyOf } from '@pterosaur/shared/types'
import { usePlayer } from '../store/player.js'
import { useSettings } from '../store/settings.js'
import { audioEl } from './audioElement.js'
import {
  canPrefetch,
  createPrefetchScheduler,
  prefetchTargets,
  type ConnectionLike,
} from '../lib/prefetch.js'

/**
 * 播放队列预载：当前曲 / 队列 / 档位变化时，重排「前后各 2 首」的预载（见 ADR-037）。
 *
 * 只订阅 `current` / `queue` / `index` / `level` / `buffering`（**不订阅 `position`**，否则会被
 * 约 20Hz 的进度回写反复触发）。`buffering` 入依赖既作门控输入，也保证缓冲结束后能重新排程
 * （已完成的靠去重表跳过）。`readyState` 高频变化故不进依赖——由 `gate` 现场读取。
 */

function getConnection(): ConnectionLike | undefined {
  return (navigator as Navigator & { connection?: ConnectionLike }).connection
}

// 模块级单例调度器（与 imageCache / lyricCache 的模块级状态风格一致）
const scheduler = createPrefetchScheduler({
  gate: () =>
    canPrefetch({
      online: navigator.onLine,
      connection: getConnection(),
      buffering: usePlayer.getState().buffering,
      readyState: audioEl.current?.readyState ?? 0,
    }),
})

export function usePlaylistPrefetch(): void {
  const current = usePlayer((s) => s.current)
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const buffering = usePlayer((s) => s.buffering)
  const level = useSettings((s) => s.level)
  const currentKey = current ? keyOf(current) : ''

  useEffect(() => {
    const targets = prefetchTargets(queue, index)
    if (!targets.length) {
      scheduler.cancel()
      return
    }
    scheduler.schedule(targets, level)
    return () => scheduler.cancel()
  }, [currentKey, queue, index, level, buffering])
}
