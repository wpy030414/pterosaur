import { Play } from 'lucide-react'
import { keyOf, type Playlist } from '@pterosaur/shared/types'
import { usePlayCollection } from '../hooks/usePlayCollection.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './Cards.css'

interface PlaylistCardProps {
  playlist: Playlist
  /** 点击卡片本体：进入歌单详情页 */
  onClick: () => void
}

/**
 * 歌单 / 排行榜卡片（方形封面 + 标题）。
 *
 * - 点击卡片本体：进入详情页；
 * - 悬浮浮现的播放按钮：立即播放该歌单（不进入详情页）。
 *
 * 预览卡**不显示任何副标题**（播放量 / 简介 / 创建者）：这些信息只在详情页给出。
 */
export function PlaylistCard({ playlist, onClick }: PlaylistCardProps) {
  const { playPlaylist } = usePlayCollection()
  return (
    <div
      className="card card--playlist"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        // 仅在卡片本体获得焦点时响应，避免误触内部播放按钮
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="card__art">
        <Cover
          src={coverAt(playlist.cover, COVER_SMALL)}
          alt={playlist.name}
          seed={keyOf(playlist)}
          radius="md"
          className="card__cover"
        />
        <button
          type="button"
          className="card__play"
          aria-label="播放"
          disabled={playlist.trackCount === 0}
          onClick={(e) => {
            e.stopPropagation()
            void playPlaylist(playlist.source, playlist.id)
          }}
        >
          <Play size={20} fill="currentColor" strokeWidth={0} />
        </button>
      </div>
      <div className="card__body">
        <div className="card__title ellipsis">{playlist.name}</div>
      </div>
    </div>
  )
}
