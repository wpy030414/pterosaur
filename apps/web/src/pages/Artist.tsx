import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Play, Star, Info } from 'lucide-react'
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
import { AlbumCard } from '../components/EntityCards.js'
import { SongRow } from '../components/SongRow.js'
import { Rail } from '../components/Rail.js'
import { RailMore } from '../components/RailMore.js'
import { ArtistInfoDialog } from '../components/ArtistInfoDialog.js'
import { coverAt, COVER_LARGE } from '@pterosaur/shared/image'
import { Loading, ErrorState } from '../components/States.js'
import './Artist.css'

interface ArtistDetail {
  artist: Artist
  tracks: Track[]
  albums: Album[]
}

/**
 * 「歌曲排行」首页滑轨展示的条数，超出时给「更多」进入完整排行子页。
 * 上游 `artists` 的 hotSongs 固定回约 50 首，子页即展示这整份热度列表。
 */
const TOP_TRACKS_LIMIT = 24

/**
 * 「专辑」「单曲与 EP」两条滑轨在艺术家页展示的条数上限。
 *
 * 数据本身**已在进入页面时一次全部载入**（后端按上游上限取回），这里只限制滑轨里铺多少张：
 * 超出的部分通过「更多」进入子页查看，避免首屏被一条长达数十张的滑轨占满。
 *
 * 判定阈值用 `>=`：恰好 N 张时滑轨已被限额充满，无法判断是否还有更多，
 * 宁可给一个「更多」入口（子页会如实显示总数），也不要让用户以为这就是全部。
 */
const WORKS_LIMIT = 20

/** 专辑是否属于「单曲与 EP」：体裁为 single / ep */
function isSingleOrEp(album: Album): boolean {
  return album.type === 'single' || album.type === 'ep'
}

/**
 * 艺术家详情页（版式对齐 Apple Music 艺术家页）。
 *
 * 自上而下：
 * 1. 通栏大图，底部渐隐到页面底色；
 * 2. 居中姓名（42px 粗体）；
 * 3. 三个操作：详情（弹出简介弹窗）、播放（较大的圆形主按钮）、收藏（星标）；
 * 4. 歌曲排行（横向滑轨，最多 24 首 + 更多）；
 * 5. 专辑（横向滑轨）；
 * 6. 单曲与 EP（横向滑轨，按体裁拆分）。
 */
export function ArtistPage() {
  const params = useParams()
  const [search] = useSearchParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  // 名字供「无按-id 取艺术家」能力的源按名搜索（当前网易云忽略它）
  const name = search.get('name') ?? undefined
  const navigate = useViewNavigate()
  const playTracks = usePlayer((s) => s.playTracks)
  const savedArtists = useLibrary((s) => s.savedArtists)
  const toggleSaveArtist = useLibrary((s) => s.toggleSaveArtist)
  const isSaved = savedArtists.some((a) => a.source === source && a.id === id)
  const [infoOpen, setInfoOpen] = useState(false)

  const { data, loading, error, reload } = useAsync<ArtistDetail>(
    () => api.artist(source, id, name),
    [source, id, name],
    null,
    id ? `artist:${source}:${id}:${name ?? ''}` : undefined,
  )

  const artist = data?.artist
  const tracks = data?.tracks ?? []
  const albums = data?.albums ?? []

  const handlePlay = () => {
    if (!tracks.length) return
    playTracks(tracks, 0)
  }

  if (loading && !artist) {
    return (
      <div className="detail">
        <Loading text="加载艺术家…" />
      </div>
    )
  }

  if (error || !artist) {
    return (
      <div className="detail">
        <ErrorState message={error ?? '艺术家不存在'} onRetry={reload} />
      </div>
    )
  }

  /*
   * 歌曲排行：上游即按热度降序，直接取前 N 首。
   * 超出 N 首时「更多」进入**全部排行**子页（展示上游返回的完整热度列表，约 50 首），
   * 而非跳去搜索结果页——那里是检索结果，不是该艺术家的排行。
   */
  const topTracks = tracks.slice(0, TOP_TRACKS_LIMIT)
  // 作品按体裁拆成「专辑」与「单曲与 EP」；体裁未知的归入专辑，避免作品凭空消失。
  // 后端已一次取到上游上限（200），这里不再二次截断——进入页面即可看到全部作品。
  const fullAlbums = albums.filter((a) => !isSingleOrEp(a))
  const singles = albums.filter(isSingleOrEp)
  // 子页与「更多」的地址：带上名字，供按名检索的源使用
  const artistQuery = name ? `?name=${encodeURIComponent(name)}` : ''
  const worksBase = `/artist/${source}/${id}`
  const allTracksTo = `${worksBase}/tracks${artistQuery}`

  return (
    <div className="artist-page detail--artist" aria-busy={loading}>
      {/* ---------- 通栏大图 + 渐隐 ---------- */}
      <div className="artist-hero">
        {artist.avatar ? (
          <img
            className="artist-hero__img"
            src={coverAt(artist.avatar, COVER_LARGE)}
            alt=""
            aria-hidden
            draggable={false}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="artist-hero__img artist-hero__img--blank" />
        )}
        <div className="artist-hero__scrim" aria-hidden />
      </div>

      {/* ---------- 姓名 + 操作 ---------- */}
      <header className="artist-head">
        <h1 className="artist-head__name">{artist.name}</h1>
        <div className="artist-head__actions">
          <button
            type="button"
            className="artist-action"
            onClick={() => setInfoOpen(true)}
            aria-label="详情"
            title="详情"
          >
            <Info size={17} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="artist-play"
            onClick={handlePlay}
            disabled={!tracks.length}
            aria-label="播放"
            title="播放"
          >
            <Play size={22} fill="currentColor" strokeWidth={0} />
          </button>
          <button
            type="button"
            className={`artist-action${isSaved ? ' artist-action--active' : ''}`}
            onClick={() => toggleSaveArtist(artist)}
            aria-pressed={isSaved}
            aria-label={isSaved ? '取消收藏' : '收藏'}
            title={isSaved ? '取消收藏' : '收藏'}
          >
            <Star
              size={17}
              strokeWidth={2}
              fill={isSaved ? 'currentColor' : 'none'}
            />
          </button>
        </div>
      </header>

      <div className="artist-sections">
        {/* ---------- 歌曲排行 ---------- */}
        {topTracks.length > 0 && (
          <Rail
            title="歌曲排行"
            itemWidth={324}
            grid
            action={
              tracks.length >= TOP_TRACKS_LIMIT ? (
                <RailMore to={allTracksTo} label="歌曲排行" />
              ) : undefined
            }
          >
            {topTracks.map((t, i) => (
              <SongRow
                key={keyOf(t)}
                track={t}
                onPlay={() => playTracks(topTracks, i)}
              />
            ))}
          </Rail>
        )}

        {/* ---------- 专辑 ----------
            作品已一次全部载入；滑轨只铺前 WORKS_LIMIT 张，其余走「更多」子页。 */}
        {fullAlbums.length > 0 && (
          <Rail
            title="专辑"
            action={
              fullAlbums.length >= WORKS_LIMIT ? (
                <RailMore
                  to={`${worksBase}/albums${artistQuery}`}
                  label="专辑"
                />
              ) : undefined
            }
          >
            {fullAlbums.slice(0, WORKS_LIMIT).map((album) => (
              <AlbumCard
                key={keyOf(album)}
                album={album}
                onClick={() => navigate(`/album/${album.source}/${album.id}`)}
              />
            ))}
          </Rail>
        )}

        {/* ---------- 单曲与 EP ---------- */}
        {singles.length > 0 && (
          <Rail
            title="单曲与 EP"
            action={
              singles.length >= WORKS_LIMIT ? (
                <RailMore
                  to={`${worksBase}/singles${artistQuery}`}
                  label="单曲与 EP"
                />
              ) : undefined
            }
          >
            {singles.slice(0, WORKS_LIMIT).map((album) => (
              <AlbumCard
                key={keyOf(album)}
                album={album}
                onClick={() => navigate(`/album/${album.source}/${album.id}`)}
              />
            ))}
          </Rail>
        )}
      </div>

      <ArtistInfoDialog
        artist={artist}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      />
    </div>
  )
}
