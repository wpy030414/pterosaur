import { Play } from 'lucide-react'
import type { Playlist } from '@pterosaur/shared/types'
import { usePlayCollection } from '../hooks/usePlayCollection.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import { CountChip } from './CountChip.js'
import { CassetteShell } from './CassetteShell.js'
import './Cards.css'

interface CassetteCardProps {
  /** 磁带（`source` 为磁带渠道的 `Playlist`）。 */
  cassette: Playlist
  /** 点击卡片本体：进入磁带详情页（选分P） */
  onClick: () => void
}

/**
 * 磁带卡片：**4:3 视频封面 + 磁带边框** + 标题 + UP 主。
 *
 * - 点击卡片本体：进入磁带详情页（`/playlist/bilibili/:bvid`）挑分P；
 * - 悬浮浮现的播放按钮：立即播放整盘磁带（全部分P，不进入详情页）；
 * - 封面右上角：分P 数量 chip（> 1 才显示）。
 *
 * 复用 `usePlayCollection`，故「整盘播放」与歌单播放走同一条代码路径（见 ADR-044）。
 */
export function CassetteCard({ cassette, onClick }: CassetteCardProps) {
  const { playPlaylist } = usePlayCollection()
  return (
    <div
      className="card card--cassette"
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
      <div className="card__art card__art--cassette">
        {/* chip 与播放按钮定位在**标签窗**（4:3 视频）内，不压到磁带外框上 */}
        <CassetteShell>
          <Cover
            src={coverAt(cassette.cover, COVER_SMALL)}
            alt={cassette.name}
            radius="sm"
            className="card__cover"
          />
          <CountChip count={cassette.trackCount} />
          <button
            type="button"
            className="card__play"
            aria-label="播放"
            disabled={cassette.trackCount === 0}
            onClick={(e) => {
              e.stopPropagation()
              void playPlaylist(cassette.source, cassette.id)
            }}
          >
            <Play size={20} fill="currentColor" strokeWidth={0} />
          </button>
        </CassetteShell>
      </div>
      <div className="card__body">
        <div className="card__title ellipsis">{cassette.name}</div>
        <div className="card__subtitle ellipsis">
          {cassette.creator ? `by ${cassette.creator}` : ''}
        </div>
      </div>
    </div>
  )
}
