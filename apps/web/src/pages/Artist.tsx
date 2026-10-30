import { useParams, useSearchParams } from 'react-router-dom'
import { Play, Shuffle, Star } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import type { Album, Artist, Track } from '@pterosaur/shared/types'
import {
  DEFAULT_SOURCE,
  keyOf,
  isMusicSource,
  type MusicSource,
} from '@pterosaur/shared/types'
import { TrackList } from '../components/TrackList.js'
import { AlbumCard } from '../components/EntityCards.js'
import { coverAt, COVER_LARGE } from '@pterosaur/shared/image'
import { Cover } from '../components/Cover.js'
import { IconButton } from '../components/IconButton.js'
import { Loading, ErrorState } from '../components/States.js'

interface ArtistDetail {
  artist: Artist
  tracks: Track[]
  albums: Album[]
}

/**
 * 艺人详情页：圆形头像 + 档案 + 热门歌曲 + 专辑网格。
 */
export function ArtistPage() {
  const params = useParams()
  const [search] = useSearchParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  // 名字供「无按-id 取歌手」能力的源按名搜索（当前网易云忽略它）
  const name = search.get('name') ?? undefined
  const navigate = useViewNavigate()
  const playTracks = usePlayer((s) => s.playTracks)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const savedArtists = useLibrary((s) => s.savedArtists)
  const toggleSaveArtist = useLibrary((s) => s.toggleSaveArtist)
  const isSaved = savedArtists.some((a) => a.source === source && a.id === id)

  const { data, loading, error, reload } = useAsync<ArtistDetail>(
    () => api.artist(source, id, name),
    [source, id, name],
    null,
    id ? `artist:${source}:${id}:${name ?? ''}` : undefined,
  )

  const artist = data?.artist
  const tracks = data?.tracks ?? []
  const albums = data?.albums ?? []

  const handlePlay = (shuffle = false) => {
    if (!tracks.length) return
    if (shuffle && !usePlayer.getState().shuffle) toggleShuffle()
    playTracks(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0)
  }

  if (loading && !artist) {
    return (
      <div className="detail">
        <Loading text="加载艺人…" />
      </div>
    )
  }

  if (error || !artist) {
    return (
      <div className="detail">
        <ErrorState message={error ?? '艺人不存在'} onRetry={reload} />
      </div>
    )
  }

  const meta = [
    artist.musicSize ? `${artist.musicSize} 首单曲` : '',
    artist.albumSize ? `${artist.albumSize} 张专辑` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="detail" aria-busy={loading}>
      <header className="detail__hero detail__hero--artist">
        <Cover
          src={coverAt(artist.avatar, COVER_LARGE)}
          alt={artist.name}
          seed={keyOf(artist)}
          rounded
          className="detail__cover"
        />
        <div className="detail__info">
          <span className="detail__type">艺人</span>
          <h1 className="detail__name">{artist.name}</h1>
          {artist.alias?.length ? (
            <p className="detail__desc">{artist.alias.join(' / ')}</p>
          ) : null}
          {meta && (
            <p className="detail__meta">
              <span>{meta}</span>
            </p>
          )}
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
          onClick={() => toggleSaveArtist(artist)}
        >
          <Star
            size={20}
            strokeWidth={2}
            fill={isSaved ? 'currentColor' : 'none'}
          />
        </IconButton>
      </div>

      <div className="detail__list">
        <TrackList tracks={tracks} emptyText="暂无热门歌曲" />
      </div>

      {albums.length > 0 && (
        <section className="section detail__section">
          <div className="section-head">
            <h2 className="section-title">专辑</h2>
          </div>
          <div className="card-grid">
            {albums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={() => navigate(`/album/${album.source}/${album.id}`)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
