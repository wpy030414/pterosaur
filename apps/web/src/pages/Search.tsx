import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type {
  MusicSource,
  Playlist,
  SearchResults,
} from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { dedupeByKey } from '../lib/dedupe.js'
import { TrackList } from '../components/TrackList.js'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { CassetteCard } from '../components/CassetteCard.js'
import { ArtistCard, AlbumCard } from '../components/EntityCards.js'
import { Loading, ErrorState, Empty } from '../components/States.js'

type SearchTab = 'songs' | 'cassette' | 'artists' | 'albums' | 'playlists'
/** 音乐结果四类（不含磁带渠道）。 */
type MusicTab = Exclude<SearchTab, 'cassette'>

const TABS: { key: SearchTab; label: string }[] = [
  { key: 'songs', label: '歌曲' },
  { key: 'cassette', label: '磁带' },
  { key: 'artists', label: '艺人' },
  { key: 'albums', label: '专辑' },
  { key: 'playlists', label: '歌单' },
]

/** 磁带渠道（B 站）源 id：独立于音乐源，磁带 tab 恒查询它。 */
const CASSETTE_SOURCE: MusicSource = 'bilibili'

/**
 * 各 tab 的**每页条数**——须与后端一致：后端 `/api/search/all` 对歌曲固定取 50、
 * 其余三类取请求里的 `limit`；B 站每页恒 20。用于判断「是否还有下一批」。
 */
const PAGE_SIZE: Record<SearchTab, number> = {
  songs: 50,
  cassette: 20,
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

/**
 * 按 `keyOf` 去重的累积列表项。
 *
 * 上游分页会**跨页返回同一实体**（实测 B 站第 1、2 页都含同一 bvid）。累积列表若带重复项，
 * React 就会遇到重复 `key` 并「duplicated and/or omitted children」——旧卡片残留在 DOM 里，
 * 换 tab 时跟着混进新 tab 的网格（见 `lib/dedupe` / ADR-046）。
 */
const uniq = <T extends { id: string; source?: MusicSource }>(list: T[]): T[] =>
  dedupeByKey(list, keyOf)

/** 单类结果的分页游标。 */
interface PageState {
  page: number
  /** 是否可能还有下一批（上一批返回满了整页）。 */
  more: boolean
  loading: boolean
}

const freshPagers = (): Record<SearchTab, PageState> => ({
  songs: { page: 1, more: false, loading: false },
  cassette: { page: 1, more: false, loading: false },
  artists: { page: 1, more: false, loading: false },
  albums: { page: 1, more: false, loading: false },
  playlists: { page: 1, more: false, loading: false },
})

/** 搜索页的累积状态（滚动续页的结果与分页游标）。 */
interface SearchPageState {
  music: SearchResults
  /** 磁带搜索结果（磁带即 `source:'bilibili'` 的 Playlist，见 ADR-044）。 */
  cassettes: Playlist[]
  pagers: Record<SearchTab, PageState>
}

/**
 * 搜索页累积状态的**会话级缓存**（`源|关键词` → 累积结果与分页游标）。
 *
 * 滚动续页累积的列表是组件 state，下钻返回重挂即丢——返回时只剩第一页，内容高度
 * 不足，滚动恢复会被浏览器**钳制**到第一页的底部（第一页不满屏时即顶部）。挂载时
 * 从这里**同步**恢复等量内容，滚动恢复才有落脚点。LRU 触碰 + 上限淘汰，防无限增长。
 */
const searchPageCache = new Map<string, SearchPageState>()
const SEARCH_CACHE_MAX = 10

function loadSearchCache(key: string): SearchPageState | undefined {
  const hit = searchPageCache.get(key)
  if (hit) {
    searchPageCache.delete(key)
    searchPageCache.set(key, hit) // LRU 触碰
  }
  return hit
}

function saveSearchCache(key: string, state: SearchPageState): void {
  searchPageCache.delete(key)
  searchPageCache.set(key, state)
  while (searchPageCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchPageCache.keys().next().value
    if (oldest === undefined) break
    searchPageCache.delete(oldest)
  }
}

/**
 * 搜索结果页。
 *
 * 关键词来自 `?q=`，音乐源来自 `?source=`（缺省跟随活动账号）。
 * 分类 tab 在四类音乐结果之外，另有一个恒查询 B 站的 **磁带** tab（只搜视频作为「磁带」、
 * 只放其音频；磁带即一个类歌单的合集，见 ADR-044）。
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
  // 查询签名（源 + 关键词）变化 → **重挂**内容组件，使「累积结果的会话级恢复」（searchPageCache）
  // 按新查询重新评估。`didRestore` 是**每挂载一次性**判定、而同挂载内查询恒定；若不重挂，则一旦
  // 本次挂载走过恢复（如下钻返回），此后换词就会**永远跳过首屏灌入**，残留上一个查询的结果。
  return <SearchResults key={`${source}|${q}`} q={q} source={source} />
}

/** 搜索结果内容（按「源|关键词」重挂，语义见 {@link SearchPage}）。 */
function SearchResults({ q, source }: { q: string; source: MusicSource }) {
  const [params, setParams] = useSearchParams()
  const navigate = useViewNavigate()
  // 分类 tab 进 URL（`?tab=`，缺省「歌曲」不占 URL）：下探返回（POP 回本历史条目）即回到
  // 所处 tab，刷新 / 分享深链同样成立；换词（顶栏 push 不带 tab）自然回到歌曲。
  // replace 更新还使 location.key 更换 → 滚动记忆（按历史条目记，见 lib/scrollMemory）
  // 按各 tab 分别记录，切 tab 即归顶。
  const tabParam = params.get('tab')
  // 兼容旧深链：磁带 tab 曾名「mv」（`?tab=mv`），别名映射到 cassette，免得静默落回「歌曲」。
  const tabKey = tabParam === 'mv' ? 'cassette' : tabParam
  const tab: SearchTab = TABS.some((t) => t.key === tabKey)
    ? (tabKey as SearchTab)
    : 'songs'

  /**
   * 同页 tab 间穿梭的滚动记忆（tab → scrollTop）。replace 切 tab 产生**新** history key、
   * 旧 key 即被丢弃，按条目记忆的 `useContentScrollRestoration` 记不住「切走前的 tab」——
   * 由这里在组件存活期间补齐（下钻返回的位置仍由按条目恢复负责，两者互补）。
   */
  const scrollByTab = useRef<Partial<Record<SearchTab, number>>>({})
  const prevTabRef = useRef<SearchTab>(tab)

  // 同页切 tab → 恢复目标 tab 上次的位置。重挂（下钻返回）时 prev === tab，跳过——
  // 那由 `useContentScrollRestoration` 按历史条目恢复；用**嵌套 rAF** 确保晚于转场的
  // `resetContentScroll`（VT 回调内同步）与滚动恢复的同帧补帧（外层 effect 后注册）。
  useLayoutEffect(() => {
    const prev = prevTabRef.current
    prevTabRef.current = tab
    if (prev === tab) return
    const saved = scrollByTab.current[tab]
    if (saved === undefined) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('.app-content')
        if (!el) return
        const s = el.style.scrollBehavior
        el.style.scrollBehavior = 'auto'
        el.scrollTop = saved
        el.style.scrollBehavior = s
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [tab])

  /** 切 tab：**replace** 不压新历史条目——返回键回到上一页，而非上个 tab。 */
  const selectTab = (key: SearchTab) => {
    const el = document.querySelector<HTMLElement>('.app-content')
    if (el) scrollByTab.current[tab] = el.scrollTop
    const next = new URLSearchParams(params)
    if (key === 'songs') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  // 累积结果（随滚动追加）；首屏由下面的 useAsync 灌入。
  // 下钻返回重挂时优先从**会话级缓存**同步恢复（等量内容是滚动恢复的前提，见
  // searchPageCache 说明）；恢复过的挂载跳过一次首屏灌入，免得把列表打回第一页。
  const cacheKey = q ? `${source}|${q}` : ''
  const restoredRef = useRef<SearchPageState | undefined>(
    cacheKey ? loadSearchCache(cacheKey) : undefined,
  )
  /** 本挂载是否已从会话级缓存恢复累积状态——若是，全程跳过 data/cassette 的覆盖式灌入。 */
  const didRestore = useRef(!!restoredRef.current)
  const [music, setMusic] = useState<SearchResults>(
    () => restoredRef.current?.music ?? EMPTY_RESULTS,
  )
  const [cassettes, setCassettes] = useState<Playlist[]>(
    () => restoredRef.current?.cassettes ?? [],
  )
  const [pagers, setPagers] = useState<Record<SearchTab, PageState>>(
    () => restoredRef.current?.pagers ?? freshPagers(),
  )

  const { data, loading, error, reload } = useAsync<SearchResults>(
    () => (q ? api.searchAll(source, q, 20) : Promise.resolve(EMPTY_RESULTS)),
    [q, source],
    EMPTY_RESULTS,
    q ? `search:${source}:${q}` : undefined,
  )

  // 磁带与音乐结果**并行**一次取齐（不等点开磁带 tab 才惰性加载）。
  // 磁带渠道的「歌单搜索」即搜磁带 → 走 `type=playlists` 短路，只跑 B 站的 searchPlaylists。
  const cassette = useAsync<SearchResults>(
    () =>
      q
        ? api.searchAll(
            CASSETTE_SOURCE,
            q,
            PAGE_SIZE.cassette,
            undefined,
            'playlists',
          )
        : Promise.resolve(EMPTY_RESULTS),
    [q],
    EMPTY_RESULTS,
    q ? `cassette:${q}` : undefined,
  )

  // 首屏（或换词 / 换源）就绪 → 重置累积结果与分页游标。
  // 「下钻返回」的挂载已从会话级缓存恢复累积结果：**全程跳过，不覆盖**，否则 data 从
  // EMPTY_RESULTS 更新到真实结果时会把恢复的长列表打回第一页（滚动恢复即被钳制）。
  useEffect(() => {
    if (didRestore.current) return
    const d = data ?? EMPTY_RESULTS
    // 首屏同样可能自带重复项（上游单页内重叠），一并去重
    setMusic({
      ...d,
      songs: uniq(d.songs),
      artists: uniq(d.artists),
      albums: uniq(d.albums),
      playlists: uniq(d.playlists),
    })
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
    if (didRestore.current) return
    const items = uniq(cassette.data?.playlists ?? [])
    setCassettes(items)
    setPagers((p) => ({
      ...p,
      cassette: {
        page: 1,
        more: items.length >= PAGE_SIZE.cassette,
        loading: false,
      },
    }))
  }, [cassette.data])

  // 累积状态变化即**同步**写回会话级缓存。用 useLayoutEffect 而非 useEffect：
  // 被动 effect 在 paint 之后才执行，用户点卡下钻时的同步 flushSync（路由转场
  // VT 回调）会让组件卸载、丢弃尚未运行的被动 effect——缓存里就是旧状态。
  useLayoutEffect(() => {
    if (!cacheKey) return
    saveSearchCache(cacheKey, { music, cassettes, pagers })
  }, [cacheKey, music, cassettes, pagers])

  // 卸载快照兜底：用 ref 始终持有最新累积状态，cleanup 里做最后一次落盘——
  // 即使 useLayoutEffect 的 deps 变化批在卸载前还没跑，这里也拿到最新事实。
  const latestStateRef = useRef<SearchPageState>({ music, cassettes, pagers })
  latestStateRef.current = { music, cassettes, pagers }
  useLayoutEffect(() => {
    return () => {
      if (!cacheKey) return
      saveSearchCache(cacheKey, latestStateRef.current)
    }
  }, [cacheKey])

  const counts: Record<SearchTab, number> = {
    songs: music.songs.length,
    cassette: cassettes.length,
    artists: music.artists.length,
    albums: music.albums.length,
    playlists: music.playlists.length,
  }
  const caps = data?.capabilities
  // 只展示当前音乐源支持的分类（capabilities 缺失视为支持）；磁带 tab 不参与该能力判定、恒可见。
  const capOf = (key: SearchTab): boolean | undefined =>
    key === 'cassette' ? true : caps?.[key]
  const visibleTabs = TABS.filter((t) => capOf(t.key) !== false)
  const activeTab = visibleTabs.some((t) => t.key === tab)
    ? tab
    : (visibleTabs[0]?.key ?? 'songs')
  // 磁带与音乐结果各自取数，故加载/出错/有无内容均按当前 tab 分流。
  const tabLoading = activeTab === 'cassette' ? cassette.loading : loading
  const tabError = activeTab === 'cassette' ? cassette.error : error
  const musicHasAny = visibleTabs.some(
    (t) => t.key !== 'cassette' && counts[t.key] > 0,
  )
  const activeCount = counts[activeTab]
  const activePage = pagers[activeTab]
  const canLoadMore = !!q && !tabLoading && !tabError && activePage.more

  /**
   * 单飞锁：**同步**标记某 tab 正在续取。
   *
   * `pagers[tab].loading` 是 state，两次背靠背触发（哨兵连发 / 快速滚动）时闭包里的它都还是
   * `false`，于是两次都取同一页码——既重复又跳页。用 ref 同步锁住。
   */
  const inflightRef = useRef<Partial<Record<SearchTab, boolean>>>({})

  /** 为当前 tab 续取下一页并追加。 */
  const loadMore = useCallback(async () => {
    const st = pagers[activeTab]
    if (!st.more || st.loading || inflightRef.current[activeTab]) return
    inflightRef.current[activeTab] = true
    const next = st.page + 1
    setPagers((p) => ({
      ...p,
      [activeTab]: { ...p[activeTab], loading: true },
    }))
    try {
      if (activeTab === 'cassette') {
        const res = await api.searchAll(
          CASSETTE_SOURCE,
          q,
          PAGE_SIZE.cassette,
          next,
          'playlists',
        )
        setCassettes((prev) => uniq([...prev, ...res.playlists]))
        setPagers((p) => ({
          ...p,
          cassette: {
            page: next,
            more: res.playlists.length >= PAGE_SIZE.cassette,
            loading: false,
          },
        }))
        return
      }
      const type: MusicTab = activeTab
      const res = await api.searchAll(source, q, PAGE_SIZE[type], next, type)
      setMusic((prev) =>
        type === 'songs'
          ? { ...prev, songs: uniq([...prev.songs, ...res.songs]) }
          : type === 'artists'
            ? { ...prev, artists: uniq([...prev.artists, ...res.artists]) }
            : type === 'albums'
              ? { ...prev, albums: uniq([...prev.albums, ...res.albums]) }
              : {
                  ...prev,
                  playlists: uniq([...prev.playlists, ...res.playlists]),
                },
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
    } finally {
      inflightRef.current[activeTab] = false
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
            onClick={() => selectTab(t.key)}
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
            onRetry={activeTab === 'cassette' ? cassette.reload : reload}
          />
        ) : (
          <>
            {activeTab === 'cassette' ? (
              activeCount > 0 ? (
                /* 磁带即类歌单合集：4:3 磁带卡。点卡本体进详情页选分P，点播放按钮整盘播放。 */
                <div className="card-grid">
                  {cassettes.map((c) => (
                    <CassetteCard
                      key={keyOf(c)}
                      cassette={c}
                      onClick={() => navigate(`/playlist/${c.source}/${c.id}`)}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  text={`没有找到与「${q}」相关的磁带`}
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
                      key={keyOf(a)}
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
                      key={keyOf(album)}
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
                    key={keyOf(p)}
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
