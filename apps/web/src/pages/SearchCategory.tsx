import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type { MusicSource, SearchResults } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { dedupeByKey } from '../lib/dedupe.js'
import { TrackList } from '../components/TrackList.js'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { CassetteCard } from '../components/CassetteCard.js'
import { ArtistCard, AlbumCard } from '../components/EntityCards.js'
import { Loading, ErrorState, Empty } from '../components/States.js'
import {
  SEARCH_PAGE_SIZE,
  SEARCH_CATEGORY_META,
  sourceForCategory,
  isSearchCategory,
  type SearchCategory,
} from '../lib/searchCategory.js'

const EMPTY_RESULTS: SearchResults = {
  songs: [],
  artists: [],
  albums: [],
  playlists: [],
}

/**
 * 独立类别页（`/search/:category?q=`）。
 *
 * 从主搜索页某个分区尾部的「更多」点进来，只对这一类无限续页：
 * 纵向网格 / 曲目表 + 底部哨兵自动追加，直到无更多。
 *
 * category 必须落在 `lib/searchCategory` 的白名单内；无效段直接落回 `/search?q=`。
 */
export function SearchCategoryPage() {
  const { category } = useParams()
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const navigate = useViewNavigate()
  const status = useAuth((st) => st.status)
  const musicSource: MusicSource = activeMusicSource(status) ?? DEFAULT_SOURCE
  const cat: SearchCategory | undefined = isSearchCategory(category)
    ? category
    : undefined

  useEffect(() => {
    if (!cat) {
      void navigate(`/search?q=${encodeURIComponent(q)}`, { replace: true })
    }
  }, [cat, q, navigate])

  if (!cat) return null
  return <CategoryBody cat={cat} q={q} musicSource={musicSource} />
}

/**
 * 某一类别的结果列表（含续页累积）。
 *
 * 累积状态放在这里而不是外层：外层只负责路由参数解析，类别 / 关键词一变，
 * 用 `key` 重挂本组件，累积列表与分页游标自然归零。
 */
function CategoryBody({
  cat,
  q,
  musicSource,
}: {
  cat: SearchCategory
  q: string
  musicSource: MusicSource
}) {
  const meta = SEARCH_CATEGORY_META[cat]
  const source = sourceForCategory(cat, musicSource)
  const pageSize = SEARCH_PAGE_SIZE[cat]
  const navigate = useViewNavigate()

  /** 已累积的该类结果（首屏 + 续页），按类别从 `SearchResults` 里取对应数组。 */
  const [items, setItems] = useState<SearchResults>(EMPTY_RESULTS)
  const pageRef = useRef(1)
  const moreRef = useRef(false)
  /** 单飞锁：`moreRef` / state 在背靠背触发时都是旧值，用 ref 同步锁防重复取同一页。 */
  const inflightRef = useRef(false)
  const [appending, setAppending] = useState(false)

  const { data, loading, error, reload } = useAsync<SearchResults>(
    () =>
      q
        ? api.searchAll(source, q, pageSize, undefined, meta.apiType)
        : Promise.resolve(EMPTY_RESULTS),
    [q, cat, source],
    EMPTY_RESULTS,
    q ? `search-cat:${cat}:${q}` : undefined,
  )

  /**
   * 首屏（或换词 / 换类别）就绪 → **重置**累积列表与分页游标。
   */
  useEffect(() => {
    const d = data ?? EMPTY_RESULTS
    const key = listKey(cat)
    const raw =
      key === 'songs'
        ? d.songs
        : key === 'artists'
          ? d.artists
          : key === 'albums'
            ? d.albums
            : d.playlists
    setItems({
      songs: key === 'songs' ? dedupeByKey(raw as typeof d.songs, keyOf) : [],
      artists:
        key === 'artists' ? dedupeByKey(raw as typeof d.artists, keyOf) : [],
      albums:
        key === 'albums' ? dedupeByKey(raw as typeof d.albums, keyOf) : [],
      playlists:
        key === 'playlists'
          ? dedupeByKey(raw as typeof d.playlists, keyOf)
          : [],
    })
    pageRef.current = 1
    moreRef.current = countOf(cat, d) >= pageSize
    inflightRef.current = false
  }, [data, cat, pageSize])

  const loadMore = useCallback(async () => {
    if (!moreRef.current || inflightRef.current) return
    inflightRef.current = true
    setAppending(true)
    const next = pageRef.current + 1
    try {
      const res = await api.searchAll(source, q, pageSize, next, meta.apiType)
      setItems((prev) => ({
        songs:
          cat === 'songs'
            ? dedupeByKey([...prev.songs, ...res.songs], keyOf)
            : prev.songs,
        artists:
          cat === 'artists'
            ? dedupeByKey([...prev.artists, ...res.artists], keyOf)
            : prev.artists,
        albums:
          cat === 'albums'
            ? dedupeByKey([...prev.albums, ...res.albums], keyOf)
            : prev.albums,
        playlists:
          cat === 'cassette' || cat === 'playlists'
            ? dedupeByKey([...prev.playlists, ...res.playlists], keyOf)
            : prev.playlists,
      }))
      moreRef.current = countOf(cat, res) >= pageSize
      pageRef.current = next
    } catch {
      // 续取失败：停止继续加载，保留已展示的结果
      moreRef.current = false
    } finally {
      inflightRef.current = false
      setAppending(false)
    }
  }, [q, cat, source, pageSize, meta.apiType])

  // 滚动哨兵：进入视口即为该类续取下一页
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [canLoadMore, setCanLoadMore] = useState(false)
  useEffect(() => {
    setCanLoadMore(moreRef.current)
  }, [items])
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

  const isBusy = loading
  const isEmpty = !isBusy && !error && countOf(cat, items) === 0

  return (
    <div className="browse">
      <header className="browse__header">
        <span className="browse__label">搜索结果</span>
        <h1 className="browse__title">
          {meta.label}「{q}」
        </h1>
      </header>

      <section className="section">
        {isBusy ? (
          <Loading text={`搜索${meta.label}…`} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <CategoryList cat={cat} items={items} navigate={navigate} />

            {!isEmpty && (
              <div className="section__more">
                {canLoadMore && (
                  <div
                    ref={sentinelRef}
                    className="section__sentinel"
                    aria-hidden
                  />
                )}
                {appending && <Loading text="加载中…" />}
                {!canLoadMore && !appending && pageRef.current > 1 && (
                  <p className="section__end">没有更多了</p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

/** 类别 → `SearchResults` 里对应的数组字段名。 */
function listKey(
  cat: SearchCategory,
): 'songs' | 'artists' | 'albums' | 'playlists' {
  switch (cat) {
    case 'songs':
      return 'songs'
    case 'artists':
      return 'artists'
    case 'albums':
      return 'albums'
    // 磁带的「视频」在接口上就是歌单（Playlist），见 lib/searchCategory
    case 'cassette':
    case 'playlists':
      return 'playlists'
  }
}

/**
 * 取某一类别的结果数组，只关心**条数**（判断本页是否满页、即还有没有下一批）。
 *
 * 返回形状恒含四个字段、`type` 短路时其余为 `[]`，故这里按 `listKey` 直接取长度，
 * 不引入联合类型转换。
 */
function countOf(cat: SearchCategory, r: SearchResults): number {
  switch (listKey(cat)) {
    case 'songs':
      return r.songs.length
    case 'artists':
      return r.artists.length
    case 'albums':
      return r.albums.length
    case 'playlists':
      return r.playlists.length
  }
}

/** 按类别派发结果渲染形态。 */
function CategoryList({
  cat,
  items,
  navigate,
}: {
  cat: SearchCategory
  items: SearchResults
  navigate: ReturnType<typeof useViewNavigate>
}) {
  const meta = SEARCH_CATEGORY_META[cat]

  if (cat === 'songs') {
    return items.songs.length ? (
      <TrackList tracks={items.songs} emptyText="没有找到相关歌曲" />
    ) : (
      <Empty
        text="没有找到相关歌曲"
        icon={<SearchX size={32} strokeWidth={1.5} />}
      />
    )
  }

  if (cat === 'artists') {
    return items.artists.length ? (
      <div className="card-grid">
        {items.artists.map((a) => (
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
      <Empty text="没有找到相关艺术家" />
    )
  }

  if (cat === 'albums') {
    return items.albums.length ? (
      <div className="card-grid">
        {items.albums.map((album) => (
          <AlbumCard
            key={keyOf(album)}
            album={album}
            onClick={() => navigate(`/album/${album.source}/${album.id}`)}
          />
        ))}
      </div>
    ) : (
      <Empty text="没有找到相关专辑" />
    )
  }

  // 歌单与磁带共用 Playlist 形状；磁带用 4:3 磁带卡
  if (!items.playlists.length) {
    return (
      <Empty
        text={
          cat === 'cassette' ? '没有找到相关磁带' : `没有找到相关${meta.label}`
        }
      />
    )
  }
  return (
    <div className="card-grid">
      {items.playlists.map((p) =>
        cat === 'cassette' ? (
          <CassetteCard
            key={keyOf(p)}
            cassette={p}
            onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
          />
        ) : (
          <PlaylistCard
            key={keyOf(p)}
            playlist={p}
            onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
          />
        ),
      )}
    </div>
  )
}
