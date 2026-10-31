import type { MutableRefObject } from 'react'
import { usePlaybackSession } from '../store/playbackSession.js'

/**
 * 全局单例 `<audio>` 元素引用。
 *
 * 引擎（useAudioEngine）持有并驱动它，UI（进度条）通过它执行命令式 seek，
 * 从而避免「store.position 回写」与「用户拖拽」互相打架。
 */
export const audioEl: MutableRefObject<HTMLAudioElement | null> = {
  current: null,
}

/**
 * 命令式跳转到指定秒数：同时更新真实播放位置与 store。
 * 供进度条拖拽 / 快进快退 / 歌词点击调用。
 */
export function seekTo(sec: number): void {
  const audio = audioEl.current
  const clamped = Math.max(0, sec)
  if (audio && Number.isFinite(audio.duration)) {
    try {
      audio.currentTime = Math.min(clamped, audio.duration)
    } catch {
      /* 元数据未就绪时忽略 */
    }
  }
  usePlaybackSession.getState().seek(clamped)
}
