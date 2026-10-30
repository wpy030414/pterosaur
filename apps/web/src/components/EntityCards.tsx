import { Play, Star } from 'lucide-react'
import type { Album, Artist } from '@pterosaur/shared/types'
import { keyOf } from '@pterosaur/shared/types'
import { usePlayCollection } from '../hooks/usePlayCollection.js'
import { useLibrary } from '../store/library.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './Cards.css'

interface ArtistCardProps {
  artist: Artist
  onClick: () => void
}

/**
 * 艺术家卡片：圆形头像 + 名称 + 单曲/专辑数。
 *
 * - 点击卡片本体：进入艺术家详情页；
 * - 悬浮浮现的星标：收藏 / 取消收藏该艺术家（`stopPropagation`，不进入详情页）。
 *
 * 因内部要嵌一个星标 `<button>`（按钮不能嵌套按钮），外层改用 `div[role=button]`，
 * 与 {@link AlbumCard} 保持一致。
 */
export function ArtistCard({ artist, onClick }: ArtistCardProps) {
  const savedArtists = useLibrary((s) => s.savedArtists)
  const toggleSaveArtist = useLibrary((s) => s.toggleSaveArtist)
  const isSaved = savedArtists.some((a) => keyOf(a) === keyOf(artist))

  const meta =
    artist.musicSize || artist.albumSize
      ? [
          artist.musicSize ? `${artist.musicSize} 首单曲` : '',
          artist.albumSize ? `${artist.albumSize} 张专辑` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : (artist.alias?.[0] ?? '')
  return (
    <div
      className="card card--artist"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        // 仅在卡片本体获得焦点时响应，避免误触内部星标按钮
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="card__art card__art--circle">
        <Cover
          src={coverAt(artist.avatar, COVER_SMALL)}
          alt={artist.name}
          seed={keyOf(artist)}
          rounded
          className="card__cover"
        />
        <button
          type="button"
          className={`card__fav${isSaved ? ' card__fav--active' : ''}`}
          aria-label={isSaved ? '取消收藏' : '收藏到资料库'}
          onClick={(e) => {
            e.stopPropagation()
            toggleSaveArtist(artist)
          }}
        >
          <Star
            size={18}
            strokeWidth={2}
            fill={isSaved ? 'currentColor' : 'none'}
          />
        </button>
      </div>
      <div className="card__body">
        <div className="card__title card__title--center ellipsis">
          {artist.name}
        </div>
        {meta && <div className="card__subtitle ellipsis">{meta}</div>}
      </div>
    </div>
  )
}

interface AlbumCardProps {
  album: Album
  /** 点击卡片本体：进入专辑详情页 */
  onClick: () => void
}

/**
 * 专辑卡片：方形封面 + 名称 + 艺术家（· 年份）。
 *
 * - 点击卡片本体：进入专辑详情页；
 * - 悬浮浮现的播放按钮：立即播放该专辑（不进入详情页）。
 */
export function AlbumCard({ album, onClick }: AlbumCardProps) {
  const { playAlbum } = usePlayCollection()
  return (
    <div
      className="card card--album"
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
          src={coverAt(album.cover, COVER_SMALL)}
          alt={album.name}
          seed={keyOf(album)}
          radius="md"
          className="card__cover"
        />
        <button
          type="button"
          className="card__play"
          aria-label="播放"
          disabled={album.trackCount === 0}
          onClick={(e) => {
            e.stopPropagation()
            void playAlbum(album.source, album.id)
          }}
        >
          <Play size={20} fill="currentColor" strokeWidth={0} />
        </button>
      </div>
      <div className="card__body">
        <div className="card__title ellipsis">{album.name}</div>
        <div className="card__subtitle ellipsis">
          {album.year ? `${album.artist} · ${album.year}` : album.artist}
        </div>
      </div>
    </div>
  )
}
