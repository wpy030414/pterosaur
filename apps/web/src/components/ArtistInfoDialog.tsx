import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ARTIST_SEPARATOR, type Artist } from '@pterosaur/shared/types'
import { IconButton } from './IconButton.js'
import './ArtistInfoDialog.css'

interface ArtistInfoDialogProps {
  artist: Artist
  open: boolean
  onClose: () => void
}

/**
 * 艺术家详情弹窗：姓名、别名、作品统计与简介。
 *
 * 简介（`briefDesc`）长度不可控（有的艺术家只有一句话，有的数千字），故正文区独立滚动，
 * 弹窗本身高度封顶，不把页面撑长。关闭方式三种：右上角按钮、点击遮罩、Esc。
 */
export function ArtistInfoDialog({
  artist,
  open,
  onClose,
}: ArtistInfoDialogProps) {
  const [closeBtn, setCloseBtn] = useState<HTMLButtonElement | null>(null)

  // 打开时把焦点移入弹窗（无障碍），并监听 Esc
  useEffect(() => {
    if (!open) return
    closeBtn?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // 打开期间锁住背景滚动
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose, closeBtn])

  if (!open) return null

  const stats = [
    artist.musicSize ? `${artist.musicSize} 首单曲` : '',
    artist.albumSize ? `${artist.albumSize} 张专辑` : '',
  ].filter(Boolean)

  return (
    <div className="artist-info__overlay" onClick={onClose} role="presentation">
      <div
        className="artist-info"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artist-info-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="artist-info__head">
          <h2 id="artist-info-title" className="artist-info__title">
            {artist.name}
          </h2>
          <IconButton
            label="关闭"
            size="sm"
            onClick={onClose}
            ref={setCloseBtn}
          >
            <X size={18} strokeWidth={2.2} />
          </IconButton>
        </header>

        <div className="artist-info__body">
          {artist.alias?.length ? (
            <p className="artist-info__row">
              <span className="artist-info__label">别名</span>
              <span>{artist.alias.join(ARTIST_SEPARATOR)}</span>
            </p>
          ) : null}
          {stats.length > 0 && (
            <p className="artist-info__row">
              <span className="artist-info__label">作品</span>
              <span>{stats.join(' · ')}</span>
            </p>
          )}
          {artist.briefDesc ? (
            <p className="artist-info__desc">{artist.briefDesc}</p>
          ) : (
            <p className="artist-info__desc artist-info__desc--empty">
              暂无艺术家简介
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
