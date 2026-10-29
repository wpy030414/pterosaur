import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, SearchX, X } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import { useSearchHistory } from '../store/searchHistory.js'
import type {
  MusicSource,
  PlaylistCategoryGroup,
  SearchResults,
} from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { dedupeByKey } from '../lib/dedupe.js'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { CassetteCard } from '../components/CassetteCard.js'
import { ArtistCard, AlbumCard } from '../components/EntityCards.js'
import { Loading, ErrorState, Empty } from '../components/States.js'
import { AppLink } from '../components/AppLink.js'
import { Rail } from '../components/Rail.js'
import { RailMore } from '../components/RailMore.js'
import { SongRow } from '../components/SongRow.js'
import { usePlayer } from '../store/player.js'
import {
  CASSETTE_SOURCE,
  SEARCH_PAGE_SIZE,
  categoryPath,
  type SearchCategory,
} from '../lib/searchCategory.js'

/** @deprecated 由 lib/searchCategory 统一管理；仓库内其他引用请改为从原文件 import。 */
export { CASSETTE_SOURCE, SEARCH_PAGE_SIZE }

const EMPTY_RESULTS: SearchResults = {
  songs: [],
  artists: [],
  albums: [],
  playlists: [],
}

/**
 * 按 `keyOf` 去重。
 *
 * 上游分页会**跨页返回同一实体**（实测 B 站第 1、2 页都含同一 bvid）。主搜索页每个分区只取
 * 一页，但单页内也可能自带重复；独立类别页续页时更是跨页累积——重复项会让 React 遇到重复
 * `key`（「duplicated and/or omitted children」），旧卡片残留在 DOM 里（见 lib/dedupe / ADR-046）。
 */
const uniq = <T extends { id: string; source?: MusicSource }>(list: T[]): T[] =>
  dedupeByKey(list, keyOf)

/**
 * 搜索页。
 *
 * 关键词来自 `?q=`，音乐源来自 `?source=`（缺省跟随活动账号）。
 *
 * **版式（ADR-050）**：搜索结果不再用 tab 分类，而是像首页「新发现」那样**五条分区滑轨**
 * 同页堆叠（歌曲 / 磁带 / 艺人 / 专辑 / 歌单，磁带恒查询 B 站，见 ADR-044）。每个分区只取
 * 一页，滑轨尾部给「更多」——想看全部就去独立类别页（`/search/{类别}?q=`，见 pages/SearchCategory）。
 * 旧深链上的 `?tab=` 参数被忽略，五条分区照常展示。
 *
 * 页面自带大搜索框（ADR-049）：顶栏移除后，搜索从「随时可用的输入框」变成「一个真正的页面」。
 */
export function SearchPage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const status = useAuth((s) => s.status)
  // 只有网易云一个音乐源，故直接跟随活动账号（未登录回落缺省源），不再单列源 tab。
  const source: MusicSource = activeMusicSource(status) ?? DEFAULT_SOURCE
  // 查询签名（源 + 关键词）变化 → **重挂**内容组件：五条滑轨的取数状态（含磁带那条独立的
  // 请求）与首屏缓存全部随新查询重建，不会残留上一个关键词的结果。
  //
  // 搜索框在**重挂之外**：它与 key 无关，否则每次换词都会连同输入焦点一起被重建。
  return (
    <div className="search-page">
      <SearchBar initialQuery={q} />
      <SearchResults key={`${source}|${q}`} q={q} source={source} />
    </div>
  )
}

/**
 * 搜索页自带的大搜索框。
 *
 * 回车提交到 `/search?q=`（push 一条新历史，故浏览器后退可回到上一个查询）。
 * `initialQuery` 只在「URL 上真正换了词」时同步回输入框——用 URL 值作依赖，
 * 避免用户敲字过程中被父组件的重渲染冲掉。
 */
function SearchBar({ initialQuery }: { initialQuery: string }) {
  const navigate = useViewNavigate()
  const location = useLocation()
  const [keyword, setKeyword] = useState(initialQuery)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // URL 上的 q 变化（深链 / 后退 / 前进）→ 同步输入框
  useEffect(() => {
    setKeyword(initialQuery)
  }, [initialQuery])

  // 进入搜索页即聚焦：这是搜索的主入口，用户来这里就是要打字
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <form
      className="search-page__bar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const q = keyword.trim()
        if (!q) return
        /*
         * 已在搜索页时**替换**历史条目而非新增：
         * - 首页点「搜索」进来是 `/search`（无 q），提交后若 push，返回键会落在那个空搜索页，
         *   看起来像「点了两次返回才离开搜索」；
         * - 连续改词同理，逐条 push 会让后退键在历史里逐个回放旧关键词。
         * 从别的页面首次进入搜索仍走 push（见侧边栏链接），故「返回」依然能回到来源页。
         */
        // 记入最近搜索（重复词只置顶），供下次进入搜索页时直达
        useSearchHistory.getState().push(q)
        const replace = location.pathname === '/search'
        void navigate(`/search?q=${encodeURIComponent(q)}`, { replace })
      }}
    >
      <SearchIcon
        size={20}
        strokeWidth={2.2}
        className="search-page__icon"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        className="search-page__input"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="搜索歌曲、艺术家、专辑…"
        aria-label="搜索"
        data-testid="search-input"
        autoComplete="off"
        spellCheck={false}
      />
    </form>
  )
}

/** 搜索结果内容（按「源|关键词」重挂，语义见 {@link SearchPage}）。 */
/**
 * 搜索落地页（未输入关键词时）。
 *
 * 版式对齐 Apple Music 搜索页：**最近搜索**在上、**各流派**在下，不放空提示占位——
 * 空白提示既不提供信息又挤占首屏；用户来这里要么接着上次的关键词、要么从流派逛。
 * 两块都用同一排可换行的**胶囊**，视觉上连成一体。
 * 点流派 → 进入该流派的歌单列表页；点历史词 → 以该词回到 `/search?q=`。
 */
function SearchLanding({ source }: { source: MusicSource }) {
  const categories = useAsync<PlaylistCategoryGroup[]>(
    () => api.categories(source),
    [source],
    [],
  )
  const terms = useSearchHistory((s) => s.terms)
  const removeTerm = useSearchHistory((s) => s.remove)
  const clearTerms = useSearchHistory((s) => s.clear)

  return (
    <>
      {terms.length > 0 && (
        <section
          className="recent-searches"
          aria-labelledby="recent-searches-title"
        >
          <header className="recent-searches__header">
            <h2 id="recent-searches-title" className="recent-searches__title">
              最近搜索
            </h2>
            <button
              type="button"
              className="recent-searches__clear"
              onClick={clearTerms}
              data-testid="search-history-clear"
            >
              清除
            </button>
          </header>
          {/* 与下方流派同一种排列：一排可换行的胶囊，而非纵向列表 */}
          <ul className="recent-searches__chips">
            {terms.map((term) => (
              <li key={term} className="recent-search">
                <AppLink
                  to={`/search?q=${encodeURIComponent(term)}`}
                  className="recent-search__link"
                >
                  <span className="recent-search__text">{term}</span>
                </AppLink>
                <button
                  type="button"
                  className="recent-search__remove"
                  aria-label={`删除搜索记录「${term}」`}
                  onClick={() => removeTerm(term)}
                  data-testid="search-history-remove"
                >
                  <X size={13} strokeWidth={2.4} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {categories.loading ? (
        <Loading text="加载分类…" />
      ) : categories.error ? (
        <ErrorState message={categories.error} onRetry={categories.reload} />
      ) : (
        categories.data?.map((group) => (
          <section key={group.name} className="genre-group">
            <h2 className="genre-group__title">{group.name}</h2>
            <div className="genre-group__tags">
              {group.tags.map((tag) => (
                <AppLink
                  key={tag}
                  to={`/genre/${encodeURIComponent(tag)}`}
                  className="genre-chip"
                >
                  {tag}
                </AppLink>
              ))}
            </div>
          </section>
        ))
      )}
    </>
  )
}

function SearchResults({ q, source }: { q: string; source: MusicSource }) {
  const navigate = useViewNavigate()
  const playTracks = usePlayer((st) => st.playTracks)

  // 音乐四类（歌曲 / 艺人 / 专辑 / 歌单）一次取齐；磁带走 CASSETTE_SOURCE（B 站），
  // 两者并行，各自的分区只管自己那条结果。
  const music = useAsync<SearchResults>(
    () =>
      q
        ? api.searchAll(source, q, SEARCH_PAGE_SIZE.songs)
        : Promise.resolve(EMPTY_RESULTS),
    [q, source],
    EMPTY_RESULTS,
    q ? `search:${source}:${q}` : undefined,
  )

  const cassette = useAsync<SearchResults>(
    () =>
      q
        ? api.searchAll(
            CASSETTE_SOURCE,
            q,
            SEARCH_PAGE_SIZE.cassette,
            undefined,
            'playlists',
          )
        : Promise.resolve(EMPTY_RESULTS),
    [q],
    EMPTY_RESULTS,
    q ? `cassette:${q}` : undefined,
  )

  if (!q) return <SearchLanding source={source} />

  // 首屏同样可能自带重复项（上游单页内重叠），一并去重
  // 上游综合搜索不保证按 limit 截断（"综合搜索" 会把 MV 等混进 songs），首屏硬截一页
  const songs = uniq(music.data?.songs ?? []).slice(0, SEARCH_PAGE_SIZE.songs)
  const artists = uniq(music.data?.artists ?? [])
  const albums = uniq(music.data?.albums ?? [])
  const playlists = uniq(music.data?.playlists ?? [])
  const cassettes = uniq(cassette.data?.playlists ?? [])

  const musicLoading = music.loading
  const musicError = music.error
  const musicReload = music.reload

  /**
   * 某分区是否有下一批（决定滑轨尾部是否给「更多」）：拿到满一页才可能有。
   * 磁带渠道单页约 20 条，不足 20 即视为已到尽头。
   */
  const hasMore = (cat: SearchCategory, count: number): boolean =>
    count > 0 && count >= SEARCH_PAGE_SIZE[cat]

  /** 分区是否渲染：磁带恒有；其余看该源是否声明了这项能力（缺省视为支持）。 */
  const visible = (cat: SearchCategory): boolean =>
    cat === 'cassette' ? true : music.data?.capabilities?.[cat] !== false

  const isBusy = musicLoading || cassette.loading
  const hasAny = [songs, artists, albums, playlists, cassettes].some(
    (list) => list.length > 0,
  )

  return (
    <div className="search">
      <header className="search__header">
        <span className="search__label">搜索结果</span>
        <h1 className="search__title">{q}</h1>
      </header>

      {/* 全部分区都没有结果（且不在加载中）才给空态；某个分区空则只是不渲染那一块 */}
      {!isBusy && !hasAny && (
        <Empty
          text={`没有找到与「${q}」相关的内容`}
          icon={<SearchX size={32} strokeWidth={1.5} />}
        />
      )}

      {/* ---------- 歌曲（紧凑曲目行，4 行 × N 列网格） ---------- */}
      {visible('songs') && (musicLoading || songs.length > 0) && (
        <Rail
          title="歌曲"
          itemWidth={324}
          grid
          action={
            !musicLoading && !musicError && hasMore('songs', songs.length) ? (
              <RailMore to={categoryPath('songs', q)} label="歌曲" />
            ) : undefined
          }
        >
          {musicLoading ? (
            <div className="rail__placeholder">
              <Loading text="加载歌曲…" />
            </div>
          ) : musicError ? (
            <div className="rail__placeholder">
              <ErrorState message={musicError} onRetry={musicReload} />
            </div>
          ) : (
            songs.map((t, i) => (
              <SongRow
                key={keyOf(t)}
                track={t}
                onPlay={() => playTracks(songs, i)}
              />
            ))
          )}
        </Rail>
      )}

      {/* ---------- 艺人 ---------- */}
      {visible('artists') && (musicLoading || artists.length > 0) && (
        <Rail
          title="艺人"
          action={
            !musicLoading &&
            !musicError &&
            hasMore('artists', artists.length) ? (
              <RailMore to={categoryPath('artists', q)} label="艺人" />
            ) : undefined
          }
        >
          {musicLoading ? (
            <div className="rail__placeholder">
              <Loading text="加载艺人…" />
            </div>
          ) : musicError ? (
            <div className="rail__placeholder">
              <ErrorState message={musicError} onRetry={musicReload} />
            </div>
          ) : (
            artists.map((a) => (
              <ArtistCard
                key={keyOf(a)}
                artist={a}
                onClick={() =>
                  navigate(
                    `/artist/${a.source}/${a.id}?name=${encodeURIComponent(a.name)}`,
                  )
                }
              />
            ))
          )}
        </Rail>
      )}

      {/* ---------- 专辑 ---------- */}
      {visible('albums') && (musicLoading || albums.length > 0) && (
        <Rail
          title="专辑"
          action={
            !musicLoading && !musicError && hasMore('albums', albums.length) ? (
              <RailMore to={categoryPath('albums', q)} label="专辑" />
            ) : undefined
          }
        >
          {musicLoading ? (
            <div className="rail__placeholder">
              <Loading text="加载专辑…" />
            </div>
          ) : musicError ? (
            <div className="rail__placeholder">
              <ErrorState message={musicError} onRetry={musicReload} />
            </div>
          ) : (
            albums.map((album) => (
              <AlbumCard
                key={keyOf(album)}
                album={album}
                onClick={() => navigate(`/album/${album.source}/${album.id}`)}
              />
            ))
          )}
        </Rail>
      )}

      {/* ---------- 歌单 ---------- */}
      {visible('playlists') && (musicLoading || playlists.length > 0) && (
        <Rail
          title="歌单"
          action={
            !musicLoading &&
            !musicError &&
            hasMore('playlists', playlists.length) ? (
              <RailMore to={categoryPath('playlists', q)} label="歌单" />
            ) : undefined
          }
        >
          {musicLoading ? (
            <div className="rail__placeholder">
              <Loading text="加载歌单…" />
            </div>
          ) : musicError ? (
            <div className="rail__placeholder">
              <ErrorState message={musicError} onRetry={musicReload} />
            </div>
          ) : (
            playlists.map((p) => (
              <PlaylistCard
                key={keyOf(p)}
                playlist={p}
                onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
              />
            ))
          )}
        </Rail>
      )}
      {/* ---------- 磁带（B 站视频合集，4:3 磁带卡） ---------- */}
      {visible('cassette') && (cassette.loading || cassettes.length > 0) && (
        <Rail
          title="磁带"
          action={
            !cassette.loading &&
            !cassette.error &&
            hasMore('cassette', cassettes.length) ? (
              <RailMore to={categoryPath('cassette', q)} label="磁带" />
            ) : undefined
          }
        >
          {cassette.loading ? (
            <div className="rail__placeholder">
              <Loading text="加载磁带…" />
            </div>
          ) : cassette.error ? (
            <div className="rail__placeholder">
              <ErrorState message={cassette.error} onRetry={cassette.reload} />
            </div>
          ) : (
            cassettes.map((c) => (
              <CassetteCard
                key={keyOf(c)}
                cassette={c}
                onClick={() => navigate(`/playlist/${c.source}/${c.id}`)}
              />
            ))
          )}
        </Rail>
      )}
    </div>
  )
}
