import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type { MusicSource, Playlist } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { dedupeByKey } from '../lib/dedupe.js'
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
 * 歌单已更新（无限续页）。
 *
 * 首屏经 `useAsync` 取第 1 页，之后由底部哨兵触发 `loadMore` 逐页追加，
 * 跨页去重（见 ADR-046）；上游回不满一页即视为到头，不再观察哨兵。
 */
function UpdatedPlaylists({
  source,
  navigate,
}: {
  source: MusicSource
  navigate: ReturnType<typeof useViewNavigate>
}) {
  const [items, setItems] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [appending, setAppending] = useState(false)

  const pageRef = useRef(1)
  const moreRef = useRef(false)
  /** 单飞锁：哨兵连续触发时 state 仍是旧值，用 ref 同步锁防重复取同一页。 */
  const inflightRef = useRef(false)
  const [canLoadMore, setCanLoadMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  /** 首屏（或重试）：重置累积列表与分页游标。 */
  const loadFirst = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    pageRef.current = 1
    moreRef.current = false
    inflightRef.current = false
    api
      .playlists(source, PAGE_SIZE, '全部', 1)
      .then((list) => {
        if (cancelled) return
        setItems(dedupeByKey(list, keyOf))
        moreRef.current = list.length >= PAGE_SIZE
        setCanLoadMore(moreRef.current)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => loadFirst(), [loadFirst])

  const loadMore = useCallback(async () => {
    if (!moreRef.current || inflightRef.current) return
    inflightRef.current = true
    setAppending(true)
    const next = pageRef.current + 1
    try {
      const list = await api.playlists(source, PAGE_SIZE, '全部', next)
      setItems((prev) => dedupeByKey([...prev, ...list], keyOf))
      moreRef.current = list.length >= PAGE_SIZE
      pageRef.current = next
    } catch {
      // 续取失败：停在当前结果，不继续观察哨兵（可刷新重来）
      moreRef.current = false
    } finally {
      inflightRef.current = false
      setAppending(false)
      setCanLoadMore(moreRef.current)
    }
  }, [source])

  // 滚动哨兵：进入视口即续取下一页
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

  if (loading) return <Loading text="加载歌单…" />
  if (error) return <ErrorState message={error} onRetry={loadFirst} />

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
        {canLoadMore && (
          <div ref={sentinelRef} className="section__sentinel" aria-hidden />
        )}
        {appending && <Loading text="加载中…" />}
        {!canLoadMore && pageRef.current > 1 && (
          <p className="section__end">没有更多了</p>
        )}
      </div>
    </section>
  )
}
