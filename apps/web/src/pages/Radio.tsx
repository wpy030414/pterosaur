import { api } from '../api/client.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type { MusicSource, Playlist } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery.js'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { Loading, ErrorState } from '../components/States.js'

/** 每批拉取的歌单数（上游精品歌单本就按 30 条一页返回）。 */
const PAGE_SIZE = 30

/**
 * 广播页：**没有止境的滚动**。
 *
 * 语义借用「广播」——不用选、一直往下就能听下去：这里把新发现页「歌单已更新」的
 * 全部内容摊开，底部哨兵自动续页，直到上游回不满一页为止（新发现页的「更多」即跳来这里）。
 *
 * 数据源与新发现页的「歌单已更新」是同一个接口（精品歌单，按更新时间倒序），
 * 只是那里只放一页横向滑轨、这里纵向无限翻。
 */
export function Radio() {
  const navigate = useViewNavigate()
  const status = useAuth((s) => s.status)
  const source = activeMusicSource(status) ?? DEFAULT_SOURCE

  return (
    <div className="browse">
      <header className="browse__header">
        <h1 className="browse__title">广播</h1>
      </header>
      {/* 源一变就用 key 重挂，累积列表与分页游标自然归零 */}
      <UpdatedPlaylists key={source} source={source} navigate={navigate} />
    </div>
  )
}

/**
 * 歌单已更新（无限续页）：分页累积规则统一在 `usePaginatedQuery` 里
 * （首屏 / 续页 / 跨页去重 / 单飞锁 / 哨兵），见 ADR-046。
 */
function UpdatedPlaylists({
  source,
  navigate,
}: {
  source: MusicSource
  navigate: ReturnType<typeof useViewNavigate>
}) {
  const {
    items,
    loading,
    appending,
    error,
    hasMore,
    page,
    sentinelRef,
    reload,
  } = usePaginatedQuery<Playlist>({
    fetchPage: (p) => api.playlists(source, PAGE_SIZE, '全部', p),
    pageSize: PAGE_SIZE,
    deps: [source],
    keyOf,
  })

  if (loading) return <Loading text="加载歌单…" />
  if (error) return <ErrorState message={error} onRetry={reload} />

  return (
    <section className="section">
      {items.length ? (
        <div className="card-grid">
          {items.map((p) => (
            <PlaylistCard
              key={keyOf(p)}
              playlist={p}
              onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
            />
          ))}
        </div>
      ) : (
        <p className="section__end">暂时没有可播放的歌单</p>
      )}

      <div className="section__more">
        {hasMore && (
          <div ref={sentinelRef} className="section__sentinel" aria-hidden />
        )}
        {appending && <Loading text="加载中…" />}
        {!hasMore && page > 1 && <p className="section__end">没有更多了</p>}
      </div>
    </section>
  )
}
