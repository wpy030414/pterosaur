import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type { Album, Playlist, Track } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { AlbumCard } from '../components/EntityCards.js'
import { Rail } from '../components/Rail.js'
import { SongRow } from '../components/SongRow.js'
import { Loading, ErrorState } from '../components/States.js'
import './pages.css'

/**
 * 「继续收听」收录上限：4 行 × 6 列 = 24 首。
 *
 * 最近播放不再有独立页面——这个分区就是它的全部出口，故给足 24 首；
 * 再多会超出「扫一眼就能挑一首」的合理体量。
 */
const RECENT_LIMIT = 24

/** 「正在流行中」收录上限：4 行 × 6 列 = 24 首。 */
const HOT_LIMIT = 24

/**
 * 新发现（首页）。
 *
 * 版面参考 Apple Music 网页版的 `/new`：**纵向堆叠若干横向滚动分区**——
 * 推荐歌单 → 新歌精选 → 本周新发行 → 歌单已更新 → 正在流行中。这样在窄屏上单类内容不必
 * 铺成巨大的网格，纵向只保留章节标题，扫读性最好。
 *
 * 顶部只有问候语：收藏与最近播放不再做捷径磁贴（它们分别由侧边栏「我喜欢的音乐」与
 * 页面底部的「继续收听」承担），避免同一入口出现两处。
 */
export function Home() {
  const navigate = useViewNavigate()
  const recent = useLibrary((s) => s.recent)
  const playTracks = usePlayer((s) => s.playTracks)
  const status = useAuth((s) => s.status)
  // 推荐跟随活动账号（未登录用缺省源）。
  const source = activeMusicSource(status) ?? DEFAULT_SOURCE

  // 四类发现内容并行取数；任一失败只影响自己那一块
  const recommend = useAsync<Playlist[]>(
    () => api.recommend(source, 20),
    [source],
    [],
  )
  const newSongs = useAsync<Track[]>(
    () => api.newSongs(source, 24),
    [source],
    [],
  )
  const newAlbums = useAsync<Album[]>(
    () => api.newAlbums(source, 12),
    [source],
    [],
  )
  // 「歌单已更新」= 精品歌单（排行榜 / 编辑精选），与上面「为你推荐」区分
  const updated = useAsync<Playlist[]>(
    () => api.playlists(source, 20),
    [source],
    [],
  )

  // 「正在流行中」= 热歌榜（实时热度排序），给足 24 首（4 行 × 6 列）
  const hotList = useAsync<Track[]>(
    () => api.hotSongs(source, HOT_LIMIT),
    [source],
    [],
  )

  // 精选单曲：取第一个推荐歌单的曲目，作为「新歌精选」缺位时的兜底
  const [featured, setFeatured] = useState<Track[]>([])
  useEffect(() => {
    const first = recommend.data?.[0]
    if (!first) return
    let cancelled = false
    api
      .playlist(first.source, first.id)
      .then(({ tracks }) => {
        if (!cancelled) setFeatured(tracks.slice(0, 8))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [recommend.data])

  const hour = new Date().getHours()
  const greeting =
    hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  /** 「新歌精选」的曲目：优先上游推荐新歌，空则退回精选单曲。 */
  const songs = newSongs.data?.length ? newSongs.data : featured

  /** 「正在流行中」的曲目；取数前不渲染该分区。 */
  const hot = hotList.data ?? []

  return (
    <div className="home">
      <header className="home__hero">
        <h1 className="home__greeting">
          {greeting}
          {status[source]?.logged && status[source].nickname
            ? `，${status[source].nickname}`
            : ''}
        </h1>
      </header>

      {/* ---------- 推荐歌单 ---------- */}
      <Rail title="推荐歌单" subtitle="根据热门与个性化推荐为你挑选">
        {recommend.loading ? (
          <div className="rail__placeholder">
            <Loading text="加载推荐…" />
          </div>
        ) : recommend.error ? (
          <div className="rail__placeholder">
            <ErrorState message={recommend.error} onRetry={recommend.reload} />
          </div>
        ) : (
          recommend.data?.map((p) => (
            <PlaylistCard
              key={keyOf(p)}
              playlist={p}
              onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
            />
          ))
        )}
      </Rail>

      {/* ---------- 新歌精选（横向多列紧凑行） ---------- */}
      {songs.length > 0 && (
        <Rail title="新歌精选" subtitle="刚刚发布的新作" itemWidth={324} grid>
          {songs.map((t) => (
            <SongRow
              key={keyOf(t)}
              track={t}
              onPlay={() => playTracks(songs, songs.indexOf(t))}
            />
          ))}
        </Rail>
      )}

      {/* ---------- 本周新发行（专辑） ---------- */}
      {newAlbums.data?.length ? (
        <Rail title="本周新发行" subtitle="最近发布的专辑">
          {newAlbums.data.map((a) => (
            <AlbumCard
              key={keyOf(a)}
              album={a}
              onClick={() => navigate(`/album/${a.source}/${a.id}`)}
            />
          ))}
        </Rail>
      ) : null}

      {/* ---------- 歌单已更新 ---------- */}
      {updated.data?.length ? (
        <Rail title="歌单已更新" subtitle="编辑精选，持续更新">
          {updated.data.map((p) => (
            <PlaylistCard
              key={keyOf(p)}
              playlist={p}
              onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
            />
          ))}
        </Rail>
      ) : null}

      {/* ---------- 正在流行中 ---------- */}
      {hot.length > 0 && (
        <Rail
          title="正在流行中"
          subtitle="当下最热门的歌曲"
          itemWidth={324}
          grid
        >
          {hot.map((t) => (
            <SongRow
              key={keyOf(t)}
              track={t}
              onPlay={() => playTracks(hot, hot.indexOf(t))}
            />
          ))}
        </Rail>
      )}

      {/* ---------- 继续收听 ---------- */}
      {recent.length > 0 && (
        <Rail title="继续收听" subtitle="最近播放过的曲目" itemWidth={324} grid>
          {recent.slice(0, RECENT_LIMIT).map((t) => (
            <SongRow
              key={keyOf(t)}
              track={t}
              onPlay={() => playTracks(recent, recent.indexOf(t))}
            />
          ))}
        </Rail>
      )}
    </div>
  )
}
