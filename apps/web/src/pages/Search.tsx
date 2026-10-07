import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import { usePlayer } from '../store/player.js'
import type { MusicSource, SearchResults, Track } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE } from '@pterosaur/shared/types'
import { expandTrack } from '../lib/mv.js'
import { TrackList } from '../components/TrackList.js'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { ArtistCard, AlbumCard } from '../components/EntityCards.js'
import { Loading, ErrorState, Empty } from '../components/States.js'

type SearchTab = 'songs' | 'mv' | 'artists' | 'albums' | 'playlists'
/** 音乐结果四类（不含 MV 渠道）。 */
type MusicTab = Exclude<SearchTab, 'mv'>

const TABS: { key: SearchTab; label: string }[] = [
  { key: 'songs', label: '歌曲' },
  { key: 'mv', label: 'MV' },
  { key: 'artists', label: '艺人' },
  { key: 'albums', label: '专辑' },
  { key: 'playlists', label: '歌单' },
]

/** MV 渠道（B 站）源 id：独立于音乐源，MV tab 恒查询它。 */
const MV_SOURCE: MusicSource = 'bilibili'

/**
 * 各 tab 的**每页条数**——须与后端一致：后端 `/api/search/all` 对歌曲固定取 50、
 * 其余三类取请求里的 `limit`；B 站每页恒 20。用于判断「是否还有下一批」。
 */
const PAGE_SIZE: Record<SearchTab, number> = {
  songs: 50,
  mv: 20,
  artists: 20,
  albums: 20,
  playlists: 20,
}

const EMPTY_RESULTS: SearchResults = {
  songs: [],
  artists: [],
  albums: [],
  playlists: [],
}

/** 单类结果的分页游标。 */
interface PageState {
  page: number
  /** 是否可能还有下一批（上一批返回满了整页）。 */
  more: boolean
  loading: boolean
}

const freshPagers = (): Record<SearchTab, PageState> => ({
  songs: { page: 1, more: false, loading: false },
  mv: { page: 1, more: false, loading: false },
  artists: { page: 1, more: false, loading: false },
  albums: { page: 1, more: false, loading: false },
  playlists: { page: 1, more: false, loading: false },
})

/**
 * 搜索结果页。
 *
 * 关键词来自 `?q=`，音乐源来自 `?source=`（缺省跟随活动账号）。
 * 分类 tab 在四类音乐结果之外，另有一个恒查询 B 站的 **MV** tab（只搜视频、只放其音频）。
 *
 * **懒加载**：滚动到底部（哨兵进入视口）时为**当前 tab** 续取下一页并追加，直到整页不满（无更多）。
 * 续取只跑该一类（`?type=`），避免每次都多打三个上游请求。
 */
export function SearchPage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const status = useAuth((s) => s.status)
  // 只有网易云一个音乐源，故直接跟随活动账号（未登录回落缺省源），不再单列源 tab。
  const source: MusicSource = activeMusicSource(status) ?? DEFAULT_SOURCE
  const navigate = useViewNavigate()
  const [tab, setTab] = useState<SearchTab>('songs')

  // 累积结果（随滚动追加）；首屏由下面的 useAsync 灌入
  const [music, setMusic] = useState<SearchResults>(EMPTY_RESULTS)
  const [mvTracks, setMvTracks] = useState<Track[]>([])
  const [pagers, setPagers] =
    useState<Record<SearchTab, PageState>>(freshPagers)

  const { data, loading, error, reload } = useAsync<SearchResults>(
    () => (q ? api.searchAll(source, q, 20) : Promise.resolve(EMPTY_RESULTS)),
    [q, source],
    EMPTY_RESULTS,
    q ? `search:${source}:${q}` : undefined,
  )

  // MV 与音乐结果**并行**一次取齐（不等点开 MV tab 才惰性加载）
  const mv = useAsync<SearchResults>(
    () =>
      q ? api.searchAll(MV_SOURCE, q, 20) : Promise.resolve(EMPTY_RESULTS),
    [q],
    EMPTY_RESULTS,
    q ? `mv:${q}` : undefined,
  )

  // 首屏（或换词 / 换源）就绪 → 重置累积结果与分页游标
  useEffect(() => {
    const d = data ?? EMPTY_RESULTS
    setMusic(d)
    setPagers((p) => ({
      ...p,
      songs: {
        page: 1,
        more: d.songs.length >= PAGE_SIZE.songs,
        loading: false,
      },
      artists: {
        page: 1,
        more: d.artists.length >= PAGE_SIZE.artists,
        loading: false,
      },
      albums: {
        page: 1,
        more: d.albums.length >= PAGE_SIZE.albums,
        loading: false,
      },
      playlists: {
        page: 1,
        more: d.playlists.length >= PAGE_SIZE.playlists,
        loading: false,
      },
    }))
  }, [data])

  useEffect(() => {
    const items = mv.data?.songs ?? []
    setMvTracks(items)
    setPagers((p) => ({
      ...p,
      mv: { page: 1, more: items.length >= PAGE_SIZE.mv, loading: false },
    }))
  }, [mv.data])

  /** 点 MV：队列 = 该视频的**分P**（一对多），只播这一个视频（见 ADR-033）。 */
  const playMv = async (track: Track) => {
    const parts = await expandTrack(track)
    usePlayer.getState().playTracks(parts, 0)
  }

  const counts: Record<SearchTab, number> = {
    songs: music.songs.length,
    mv: mvTracks.length,
    artists: music.artists.length,
    albums: music.albums.length,
    playlists: music.playlists.length,
  }
  const caps = data?.capabilities
  // 只展示当前音乐源支持的分类（capabilities 缺失视为支持）；MV tab 不参与该能力判定、恒可见。
  const capOf = (key: SearchTab): boolean | undefined =>
    key === 'mv' ? true : caps?.[key]
  const visibleTabs = TABS.filter((t) => capOf(t.key) !== false)
  const activeTab = visibleTabs.some((t) => t.key === tab)
    ? tab
    : (visibleTabs[0]?.key ?? 'songs')
  // MV 与音乐结果各自取数，故加载/出错/有无内容均按当前 tab 分流。
  const tabLoading = activeTab === 'mv' ? mv.loading : loading
  const tabError = activeTab === 'mv' ? mv.error : error
  const musicHasAny = visibleTabs.some(
    (t) => t.key !== 'mv' && counts[t.key] > 0,
  )
  const activeCount = counts[activeTab]
  const activePage = pagers[activeTab]
  const canLoadMore = !!q && !tabLoading && !tabError && activePage.more

  /** 为当前 tab 续取下一页并追加。 */
  const loadMore = useCallback(async () => {
    const st = pagers[activeTab]
    if (!st.more || st.loading) return
    const next = st.page + 1
    setPagers((p) => ({
      ...p,
      [activeTab]: { ...p[activeTab], loading: true },
    }))
    try {
      if (activeTab === 'mv') {
        const res = await api.searchAll(
          MV_SOURCE,
          q,
          PAGE_SIZE.mv,
          next,
          'songs',
        )
        setMvTracks((prev) => [...prev, ...res.songs])
        setPagers((p) => ({
          ...p,
          mv: {
            page: next,
            more: res.songs.length >= PAGE_SIZE.mv,
            loading: false,
          },
        }))
        return
      }
      const type: MusicTab = activeTab
      const res = await api.searchAll(source, q, PAGE_SIZE[type], next, type)
      setMusic((prev) =>
        type === 'songs'
          ? { ...prev, songs: [...prev.songs, ...res.songs] }
          : type === 'artists'
            ? { ...prev, artists: [...prev.artists, ...res.artists] }
            : type === 'albums'
              ? { ...prev, albums: [...prev.albums, ...res.albums] }
              : { ...prev, playlists: [...prev.playlists, ...res.playlists] },
      )
      const got =
        type === 'songs'
          ? res.songs.length
          : type === 'artists'
            ? res.artists.length
            : type === 'albums'
              ? res.albums.length
              : res.playlists.length
      setPagers((p) => ({
        ...p,
        [type]: { page: next, more: got >= PAGE_SIZE[type], loading: false },
      }))
    } catch {
      // 续取失败：停止继续加载，保留已展示的结果
      setPagers((p) => ({
        ...p,
        [activeTab]: { ...p[activeTab], loading: false, more: false },
      }))
    }
  }, [pagers, activeTab, source, q])

  // 滚动哨兵：进入视口即为当前 tab 续取下一页
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!canLoadMore) return
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const root = document.querySelector('.app-content')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [canLoadMore, loadMore])

  if (!q) {
    return (
      <div className="search">
        <header className="search__header">
          <span className="search__label">搜索</span>
          <h1 className="search__title">输入关键词开始畅听</h1>
        </header>
        <Empty
          text="在上方搜索框输入歌曲、艺人或专辑名"
          icon={<SearchX size={32} strokeWidth={1.5} />}
        />
      </div>
    )
  }

  return (
    <div className="search">
      <header className="search__header">
        <span className="search__label">搜索结果</span>
        <h1 className="search__title">“{q}”</h1>
      </header>

      <div className="search__tabs" role="tablist" aria-label="搜索结果分类">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`browse__tab${activeTab === t.key ? ' browse__tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section className="search__results">
        {tabLoading ? (
          <Loading text="搜索中…" />
        ) : tabError ? (
          <ErrorState
            message={tabError}
            onRetry={activeTab === 'mv' ? mv.reload : reload}
          />
        ) : (
          <>
            {activeTab === 'mv' ? (
              activeCount > 0 ? (
                /* MV 无专辑概念，专辑列恒空 → 不显示（标题列随之加宽） */
                <TrackList
                  tracks={mvTracks}
                  emptyText="没有找到相关 MV"
                  showAlbum={false}
                  onPlayRow={(t) => void playMv(t)}
                />
              ) : (
                <Empty
                  text={`没有找到与「${q}」相关的 MV`}
                  icon={<SearchX size={32} strokeWidth={1.5} />}
                />
              )
            ) : !musicHasAny ? (
              <Empty
                text={`没有找到与「${q}」相关的内容`}
                icon={<SearchX size={32} strokeWidth={1.5} />}
              />
            ) : activeTab === 'songs' ? (
              <TrackList tracks={music.songs} emptyText="没有找到相关歌曲" />
            ) : activeTab === 'artists' ? (
              music.artists.length ? (
                <div className="card-grid">
                  {music.artists.map((a) => (
                    <ArtistCard
                      key={a.id}
                      artist={a}
                      onClick={() =>
                        navigate(
                          `/artist/${a.source}/${a.id}?name=${encodeURIComponent(a.name)}`,
                        )
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty text="没有找到相关艺人" />
              )
            ) : activeTab === 'albums' ? (
              music.albums.length ? (
                <div className="card-grid">
                  {music.albums.map((album) => (
                    <AlbumCard
                      key={album.id}
                      album={album}
                      onClick={() =>
                        navigate(`/album/${album.source}/${album.id}`)
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty text="没有找到相关专辑" />
              )
            ) : music.playlists.length ? (
              <div className="card-grid">
                {music.playlists.map((p) => (
                  <PlaylistCard
                    key={p.id}
                    playlist={p}
                    onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
                  />
                ))}
              </div>
            ) : (
              <Empty text="没有找到相关歌单" />
            )}

            {/* 分页尾部：仅在有结果时出现——哨兵进入视口即续取下一批 */}
            {activeCount > 0 && (
              <div className="search__more">
                {canLoadMore && (
                  <div
                    ref={sentinelRef}
                    className="search__sentinel"
                    aria-hidden
                  />
                )}
                {activePage.loading && <Loading text="加载中…" />}
                {!activePage.more &&
                  !activePage.loading &&
                  activePage.page > 1 && (
                    <p className="search__end">没有更多了</p>
                  )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
