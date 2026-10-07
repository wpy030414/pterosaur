import { useParams } from 'react-router-dom'
import { Play, Shuffle, Heart } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { confirmDialog } from '../store/ui.js'
import type { Album, Track } from '@pterosaur/shared/types'
import {
  DEFAULT_SOURCE,
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
 * 专辑详情页：封面 + 档案（含可点击的艺人）+ 曲目列表。
 */
export function AlbumPage() {
  const params = useParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  const navigate = useViewNavigate()
  const playTracks = usePlayer((s) => s.playTracks)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const level = useSettings((s) => s.level)
  const savedAlbums = useLibrary((s) => s.savedAlbums)
  const toggleSaveAlbum = useLibrary((s) => s.toggleSaveAlbum)
  const isSaved = savedAlbums.some((a) => a.source === source && a.id === id)

  // 翻录进度：从全局 store 认领属于本专辑的那份（切走再回自动恢复）
  const ripKey = `album:${source}:${id}`
  const ripJob = useRip((s) => s.job)
  const myRip =
    ripJob?.key === ripKey
      ? { current: ripJob.current, total: ripJob.total }
      : null

  const { data, loading, error, reload } = useAsync<AlbumDetail>(
    () => api.album(source, id),
    [source, id],
    null,
    id ? `album:${source}:${id}` : undefined,
  )

  const album = data?.album
  const tracks = data?.tracks ?? []

  const handlePlay = (shuffle = false) => {
    if (!tracks.length) return
    if (shuffle && !usePlayer.getState().shuffle) toggleShuffle()
    playTracks(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0)
  }

  const handleDownloadPlaylist = async () => {
    if (!album || !tracks.length || isRipping()) return
    const dur = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const durStr = dur > 0 ? `，总时长约 ${Math.round(dur / 60)} 分钟` : ''
    const ok = await confirmDialog({
      title: '翻录专辑？',
      message: `将打包下载 ${tracks.length} 首曲目${durStr}，并附带专辑封面。`,
      confirmText: '开始翻录',
    })
    if (!ok) return
    await runRip({
      key: ripKey,
      tracks,
      zipName: `${album.name} - ${album.artist}`,
      // 翻录封面取尽可能大的档（COVER_RIP=3000，母带上限）——入 ZIP 的封面不进缓存、
      // 无需顾及流量，与页面展示（COVER_LARGE）分档互不影响
      coverUrl: coverAt(album.cover, COVER_RIP),
      level,
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

  const meta = [
    album.year ? String(album.year) : '',
    tracks.length ? `${tracks.length} 首` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="detail" aria-busy={loading}>
      <header className="detail__hero">
        <Cover
          src={coverAt(album.cover, COVER_LARGE)}
          alt={album.name}
          radius="lg"
          className="detail__cover"
        />
        <div className="detail__info">
          <span className="detail__type">专辑</span>
          <h1 className="detail__name">{album.name}</h1>
          <p className="detail__meta">
            {album.artistId ? (
              <button
                type="button"
                className="detail__artist-link"
                onClick={() =>
                  navigate(
                    `/artist/${album.source}/${album.artistId}?name=${encodeURIComponent(album.artist)}`,
                  )
                }
              >
                {album.artist}
              </button>
            ) : (
              <span>{album.artist}</span>
            )}
            {meta && <span> · {meta}</span>}
          </p>
        </div>
      </header>

      <div className="detail__actions">
        <button
          type="button"
          className="detail__play"
          onClick={() => handlePlay(false)}
          disabled={!tracks.length}
        >
          <Play size={18} fill="currentColor" strokeWidth={0} />
          播放
        </button>
        <IconButton
          label="随机播放"
          size="lg"
          onClick={() => handlePlay(true)}
          disabled={!tracks.length}
        >
          <Shuffle size={20} strokeWidth={2} />
        </IconButton>
        <IconButton
          label={isSaved ? '取消收藏' : '收藏到资料库'}
          size="lg"
          active={isSaved}
          onClick={() => toggleSaveAlbum(album)}
        >
          <Heart
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

      <div className="detail__list">
        <TrackList tracks={tracks} emptyText="这张专辑还没有曲目" />
      </div>
    </div>
  )
}
