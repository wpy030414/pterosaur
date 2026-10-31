import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SearchX } from 'lucide-react'
import { api } from '../api/client.js'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type {
  Album,
  Artist,
  MusicSource,
  Playlist,
  SearchResults,
  Track,
} from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
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

  // 分页累积规则统一在 usePaginatedQuery（首屏 / 续页 / 去重 / 单飞锁 / 哨兵）。
  // 上游每批返回四类字段、`type` 短路时其余为空，故只取本类别的那一份。
  const {
    items,
    loading,
    appending,
    error,
    hasMore,
    page,
    sentinelRef,
    reload,
  } = usePaginatedQuery<CatalogItem>({
    fetchPage: async (p) => {
      if (!q) return []
      const r = await api.searchAll(source, q, pageSize, p, meta.apiType)
      return itemsOf(cat, r)
    },
    pageSize,
    deps: [q, cat, source],
    keyOf: catalogKeyOf,
    enabled: Boolean(q),
  })

  const isBusy = loading
  const isEmpty = !isBusy && !error && items.length === 0

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
                {hasMore && (
                  <div
                    ref={sentinelRef}
                    className="section__sentinel"
                    aria-hidden
                  />
                )}
                {appending && <Loading text="加载中…" />}
                {!hasMore && !appending && page > 1 && (
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

/**
 * 分页结果的判别联合：**类型与类别绑定**，渲染分支按 `kind` 收窄，
 * 无需 `as` 强转（此前用 `SearchResults` 四字段平铺 + 强转，类型与类别不一致时编译器无法发现）。
 */
type CatalogItem =
  | { kind: 'songs'; item: Track }
  | { kind: 'artists'; item: Artist }
  | { kind: 'albums'; item: Album }
  | { kind: 'playlists'; item: Playlist }

/** 按类别把一页结果包装成判别联合（全仓唯一的类别 → 字段映射）。 */
function itemsOf(cat: SearchCategory, r: SearchResults): CatalogItem[] {
  switch (cat) {
    case 'songs':
      return r.songs.map((item) => ({ kind: 'songs', item }))
    case 'artists':
      return r.artists.map((item) => ({ kind: 'artists', item }))
    case 'albums':
      return r.albums.map((item) => ({ kind: 'albums', item }))
    // 磁带的「视频」在接口上就是歌单（Playlist），见 lib/searchCategory
    case 'cassette':
    case 'playlists':
      return r.playlists.map((item) => ({ kind: 'playlists', item }))
  }
}

/** 判别联合的身份键。 */
const catalogKeyOf = (i: CatalogItem): string => keyOf(i.item)

/** 按类别派发结果渲染形态。 */
function CategoryList({
  cat,
  items,
  navigate,
}: {
  cat: SearchCategory
  items: CatalogItem[]
  navigate: ReturnType<typeof useViewNavigate>
}) {
  const meta = SEARCH_CATEGORY_META[cat]

  const songs = items.flatMap((i) => (i.kind === 'songs' ? [i.item] : []))
  if (cat === 'songs') {
    return songs.length ? (
      <TrackList tracks={songs} emptyText="没有找到相关歌曲" />
    ) : (
      <Empty
        text="没有找到相关歌曲"
        icon={<SearchX size={32} strokeWidth={1.5} />}
      />
    )
  }

  if (cat === 'artists') {
    const artists = items.flatMap((i) => (i.kind === 'artists' ? [i.item] : []))
    return artists.length ? (
      <div className="card-grid">
        {artists.map((a) => (
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
    const albums = items.flatMap((i) => (i.kind === 'albums' ? [i.item] : []))
    return albums.length ? (
      <div className="card-grid">
        {albums.map((album) => (
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

  // 歌单与磁带共用 Playlist 形状；磁带用 16:9 磁带卡
  const playlists = items.flatMap((i) =>
    i.kind === 'playlists' ? [i.item] : [],
  )
  if (!playlists.length) {
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
      {playlists.map((p) =>
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
