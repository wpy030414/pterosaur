import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import type { Album, Artist, Track } from '@pterosaur/shared/types'
import {
  DEFAULT_SOURCE,
  keyOf,
  isMusicSource,
  type MusicSource,
} from '@pterosaur/shared/types'
import { AlbumCard } from '../components/EntityCards.js'
import { TrackList } from '../components/TrackList.js'
import { Loading, ErrorState, Empty } from '../components/States.js'
import { AppLink } from '../components/AppLink.js'
import '../pages/pages.css'
import './ArtistWorks.css'

/**
 * 子页类别：
 * - `tracks`：完整歌曲排行（上游 hotSongs 全量，约 50 首）；
 * - `albums` / `singles`：该艺术家的全部作品，按体裁拆分。
 */
export type WorksKind = 'tracks' | 'albums' | 'singles'

interface ArtistDetail {
  artist: Artist
  tracks: Track[]
  albums: Album[]
}

const COPY: Record<
  WorksKind,
  { label: string; title: string; unit: string; empty: string }
> = {
  tracks: {
    label: '歌曲排行',
    title: '歌曲排行',
    unit: '首',
    empty: '这位艺术家还没有可播放的歌曲',
  },
  albums: {
    label: '专辑',
    title: '全部专辑',
    unit: '张',
    empty: '这位艺术家还没有专辑',
  },
  singles: {
    label: '单曲与 EP',
    title: '全部单曲与 EP',
    unit: '张',
    empty: '这位艺术家还没有单曲或 EP',
  },
}

/** 专辑是否属于「单曲与 EP」：体裁为 single / ep */
function isSingleOrEp(album: Album): boolean {
  return album.type === 'single' || album.type === 'ep'
}

/**
 * 艺术家子页：完整歌曲排行，或全部专辑 / 单曲与 EP。
 *
 * 由艺术家页各滑轨的「更多」进入。数据复用 `api.artist`——后端已按上游上限一次性取回
 * （歌曲为 hotSongs 全量，作品为单次上限 200 张），故无需额外的分页接口。
 */
export function ArtistWorksPage({ kind }: { kind: WorksKind }) {
  const params = useParams()
  const [search] = useSearchParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  const name = search.get('name') ?? undefined
  const navigate = useViewNavigate()
  const playTracks = usePlayer((s) => s.playTracks)
  const copy = COPY[kind]

  const { data, loading, error, reload } = useAsync<ArtistDetail>(
    () => api.artist(source, id, name),
    [source, id, name],
    null,
    id ? `artist:${source}:${id}:${name ?? ''}` : undefined,
  )

  const artist = data?.artist
  const albums = data?.albums ?? []
  const tracks = data?.tracks ?? []
  const works =
    kind === 'tracks'
      ? tracks
      : kind === 'singles'
        ? albums.filter(isSingleOrEp)
        : albums.filter((a) => !isSingleOrEp(a))

  // 返回艺术家页时带上名字，供按名检索的源使用
  const backTo = `/artist/${source}/${id}${name ? `?name=${encodeURIComponent(name)}` : ''}`

  if (loading && !artist) {
    return (
      <div className="artist-works">
        <Loading text={`加载${copy.label}…`} />
      </div>
    )
  }

  if (error || !artist) {
    return (
      <div className="artist-works">
        <ErrorState message={error ?? '艺术家不存在'} onRetry={reload} />
      </div>
    )
  }

  return (
    <div className="artist-works">
      <header className="artist-works__header">
        <AppLink to={backTo} className="artist-works__back">
          <ArrowLeft size={16} strokeWidth={2.2} />
          <span className="ellipsis">{artist.name}</span>
        </AppLink>
        <h1 className="artist-works__title">{copy.title}</h1>
        <p className="artist-works__count">
          {works.length} {copy.unit}
        </p>
      </header>

      {works.length === 0 ? (
        <Empty text={copy.empty} />
      ) : kind === 'tracks' ? (
        // 完整排行用表格行：带序号、时长与行内操作，适合纵向浏览
        <TrackList
          tracks={tracks}
          onPlayRow={(_, index) => playTracks(tracks, index)}
        />
      ) : (
        <div className="card-grid">
          {(works as Album[]).map((album) => (
            <AlbumCard
              key={keyOf(album)}
              album={album}
              onClick={() => navigate(`/album/${album.source}/${album.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}