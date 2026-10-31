import { useCallback } from 'react'
import type { MusicSource } from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { playerCommands } from '../store/player.js'

/**
 * 卡片上「播放」按钮的集合播放动作。
 *
 * 与「点击卡片本体进入详情页」区分：这里拉取歌单 / 专辑曲目后立即从头播放。
 * 拉取失败时保持当前播放不变（静默）。
 */
export function usePlayCollection() {
  const playTracks = playerCommands.playTracks

  const playPlaylist = useCallback(
    async (source: MusicSource, id: string) => {
      try {
        const { tracks } = await api.playlist(source, id)
        if (tracks.length) playTracks(tracks, 0)
      } catch {
        /* 拉取失败：不改变当前播放 */
      }
    },
    [playTracks],
  )

  const playAlbum = useCallback(
    async (source: MusicSource, id: string) => {
      try {
        const { tracks } = await api.album(source, id)
        if (tracks.length) playTracks(tracks, 0)
      } catch {
        /* 拉取失败：不改变当前播放 */
      }
    },
    [playTracks],
  )

  return { playPlaylist, playAlbum }
}
