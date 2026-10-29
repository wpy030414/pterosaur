import { Play } from 'lucide-react'
import type { Track } from '@pterosaur/shared/types'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './SongRow.css'

interface SongRowProps {
  track: Track
  onPlay: () => void
  /** 右侧的额外操作（如「添加到歌单」菜单）。 */
  trailing?: React.ReactNode
}

/**
 * 「新歌精选」用的紧凑曲目行（封面 + 曲名 / 艺人）。
 *
 * 与 `TrackList` 的表格行不同：这里没有序号、时长与专辑列，只为在横向 / 多列
 * 密排时保持可读性（对齐 Apple Music 发现页的新歌列表）。
 */
export function SongRow({ track, onPlay, trailing }: SongRowProps) {
  return (
    <div className="song-row">
      <button
        type="button"
        className="song-row__main"
        onClick={onPlay}
        aria-label={`播放 ${track.title}`}
      >
        <Cover
          src={coverAt(track.cover, COVER_SMALL)}
          alt={track.title}
          radius="sm"
          size={44}
        />
        <span className="song-row__text">
          <span className="song-row__title ellipsis">{track.title}</span>
          <span className="song-row__artist ellipsis">{track.artist}</span>
        </span>
        <span className="song-row__play" aria-hidden>
          <Play size={15} fill="currentColor" strokeWidth={0} />
        </span>
      </button>
      {trailing && <div className="song-row__trailing">{trailing}</div>}
    </div>
  )
}
