import { useEffect } from 'react'
import { playerCommands } from '../store/player.js'
import { usePlayerQueue } from '../store/playerQueue.js'
import { usePlaybackSession } from '../store/playbackSession.js'
import { usePlayerUi } from '../store/playerUi.js'
import { seekTo } from './audioElement.js'
import { startNowPlayingTransition } from '../lib/nowPlayingTransition.js'

/**
 * 全局键盘快捷键（参考 Apple Music / Spotify 网页版习惯）：
 *
 * - `Space` 播放 / 暂停
 * - `←` / `→` 快退 / 快进 5 秒
 * - `↑` / `↓` 音量增减
 * - `M` 静音切换
 * - `S` 随机切换
 * - `R` 循环模式切换
 * - `N` / `P` 下一首 / 上一首
 * - `/` 聚焦搜索框
 * - `Esc` 关闭全屏播放页 / 弹窗
 *
 * 在输入框、文本域内（除 Space 外）不拦截，避免影响输入。
 */
export function useKeyboardShortcuts(onFocusSearch?: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isTyping =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable

      // Esc 总是生效（关闭浮层）
      if (e.key === 'Escape') {
        if (usePlayerUi.getState().expanded) {
          // 与点击关闭一致：走共享元素转场（不支持时内部自动降级）
          startNowPlayingTransition(false)
          return
        }
      }

      if (isTyping) return

      // 三类状态各取所需：瞬时状态、队列偏好、跨 store 命令
      const playback = usePlaybackSession.getState()
      const prefs = usePlayerQueue.getState()
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          playerCommands.toggle()
          break
        case 'ArrowRight':
          e.preventDefault()
          seekTo(playback.position + 5)
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekTo(Math.max(0, playback.position - 5))
          break
        case 'ArrowUp':
          e.preventDefault()
          prefs.setVolume(Math.min(1, prefs.volume + 0.05))
          break
        case 'ArrowDown':
          e.preventDefault()
          prefs.setVolume(Math.max(0, prefs.volume - 0.05))
          break
        case 'm':
        case 'M':
          prefs.toggleMute()
          break
        case 's':
        case 'S':
          playerCommands.toggleShuffle()
          break
        case 'r':
        case 'R':
          prefs.cycleRepeat()
          break
        case 'n':
        case 'N':
          playerCommands.next()
          break
        case 'p':
        case 'P':
          playerCommands.prev()
          break
        case '/':
          e.preventDefault()
          onFocusSearch?.()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onFocusSearch])
}
