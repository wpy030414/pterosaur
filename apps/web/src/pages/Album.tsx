import { useParams } from 'react-router-dom'
import { Play, Star } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { ripDialog } from '../store/ui.js'
import type { Album, Track } from '@pterosaur/shared/types'
import {
  ARTIST_SEPARATOR,
  DEFAULT_SOURCE,
  keyOf,
  isMusicSource,
  type MusicSource,
} from '@pterosaur/shared/types'
import { coverAt, COVER_LARGE, COVER_RIP } from '@pterosaur/shared/image'
import { useSettings } from '../store/settings.js'
import { TrackList } from '../components/TrackList.js'
import { Cover } from '../components/Cover.js'
import { IconButton } from '../components/IconButton.js'
import { RipButton } from '../components/RipButton.js'
import { Loading, ErrorState } from '../components/States.js'
import { useRip } from '../store/rip.js'
import { isRipping, runRip } from '../lib/rip.js'

interface AlbumDetail {
  album: Album
  tracks: Track[]
}

/**
 * 专辑详情页：封面 + 档案（含可点击的艺术家）+ 曲目列表。
 */
export function AlbumPage() {
  const params = useParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  const navigate = useViewNavigate()
  const playTracks = usePlayer((s) => s.playTracks)
  const level = useSettings((s) => s.level)
  const savedAlbums = useLibrary((s) => s.savedAlbums)
  const toggleSaveAlbum = useLibrary((s) => s.toggleSaveAlbum)
  const isSaved = savedAlbums.some((a) => a.source === source && a.id === id)

  // 翻录进度：从全局 store 认领属于本专辑的那份（切走再回自动恢复）
  const ripKey = `album:${source}:${id}`
  const ripJob = useRip((s) => s.job)
  const myRip = ripJob?.key === ripKey ? ripJob : null

  const { data, loading, error, reload } = useAsync<AlbumDetail>(
    () => api.album(source, id),
    [source, id],
    null,
    id ? `album:${source}:${id}` : undefined,
  )

  const album = data?.album
  const tracks = data?.tracks ?? []

  const handlePlay = () => {
    if (!tracks.length) return
    playTracks(tracks, 0)
  }

  const handleDownloadPlaylist = async () => {
    if (!album || !tracks.length || isRipping()) return
    // 翻录封面取尽可能大的档（COVER_RIP=3000，母带上限）——入 ZIP / 上盘 / 元信息共用同一地址，
    // 与页面展示（COVER_LARGE）分档互不影响
    const coverUrl = coverAt(album.cover, COVER_RIP)
    const name = `${album.name} - ${album.artist}`
    const mixed = new Set(tracks.map((t) => t.source)).size > 1
    const choice = await ripDialog({
      name,
      trackCount: tracks.length,
      totalDuration: tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
      mixedSources: mixed,
    })
    if (!choice) return
    await runRip({
      key: ripKey,
      tracks,
      meta: {
        kind: 'album',
        name,
        source: mixed ? undefined : (tracks[0]?.source ?? source),
        sourceId: id,
        creator: album.artist,
      },
      coverUrl,
      level,
      choice,
    })
  }

  if (loading && !album) {
    return (
      <div className="detail">
        <Loading text="加载专辑…" />
      </div>
    )
  }

  if (error || !album) {
    return (
      <div className="detail">
        <ErrorState message={error ?? '专辑不存在'} onRetry={reload} />
      </div>
    )
  }

  return (
    <div className="detail detail--album" aria-busy={loading}>
      <header className="detail__hero">
        <Cover
          src={coverAt(album.cover, COVER_LARGE)}
          alt={album.name}
          seed={keyOf(album)}
          radius="lg"
          className="detail__cover"
        />
        <div className="detail__info">
          {/* 标题上方的呼吸空行：与标题同高（见 pages.css 的 .detail__lead-space） */}
          <div className="detail__lead-space" aria-hidden />
          <h1 className="detail__name">{album.name}</h1>
          <p className="detail__artist">
            {albumArtistLinks(album, navigate) ?? <span>{album.artist}</span>}
          </p>
          {(album.genre || album.year) && (
            <p className="detail__year">
              {[album.genre, album.year ? `${album.year}年` : '']
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}

          <div className="detail__actions">
            <button
              type="button"
              className="detail__play"
              onClick={handlePlay}
              disabled={!tracks.length}
            >
              <Play size={18} fill="currentColor" strokeWidth={0} />
              播放
            </button>
            <IconButton
              label={isSaved ? '取消收藏' : '收藏到资料库'}
              size="lg"
              active={isSaved}
              onClick={() => toggleSaveAlbum(album)}
            >
              <Star
                size={20}
                strokeWidth={2}
                fill={isSaved ? 'currentColor' : 'none'}
              />
            </IconButton>
            <RipButton
              progress={myRip}
              disabled={
                !tracks.length || (ripJob !== null && ripJob.key !== ripKey)
              }
              onClick={handleDownloadPlaylist}
            />
          </div>
        </div>
      </header>

      {/* 专辑页整页同一张专辑、同一批艺术家：行内不再重复封面 / 艺术家 / 专辑列 */}
      <div className="detail__list">
        <TrackList
          tracks={tracks}
          showAlbum={false}
          showCover={false}
          showArtist={false}
          emptyText="这张专辑还没有曲目"
          showSummary
        />
      </div>
    </div>
  )
}

/**
 * 专辑艺术家的可点击链接（合作专辑逐个可点）。
 *
 * 优先用 `artistRefs`（每个艺术家都有 id）；旧数据只有 `artistId` 时用整体名串兜底；
 * 都没有时返回 `null`，由调用方降级为纯文本。
 */
function albumArtistLinks(
  album: Album,
  navigate: (to: string) => void,
): React.ReactNode {
  const refs = album.artistRefs?.length
    ? album.artistRefs
    : album.artistId
      ? [{ id: album.artistId, name: album.artist }]
      : []
  if (!refs.length) return null
  return refs.map((a, i) => (
    <span key={`${a.id}-${i}`}>
      {i > 0 && ARTIST_SEPARATOR}
      <button
        type="button"
        className="detail__artist-link"
        onClick={() =>
          navigate(
            `/artist/${album.source}/${a.id}?name=${encodeURIComponent(a.name)}`,
          )
        }
      >
        {a.name}
      </button>
    </span>
  ))
}
