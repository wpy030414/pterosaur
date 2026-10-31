import { useCallback, useEffect, useRef, useState } from 'react'
import { dedupeByKey } from '../lib/dedupe.js'

/**
 * 分页累积取数的统一实现（搜索类别页 / 广播页共用）。
 *
 * 此前「取一页 → 续页 → 跨页去重 → 底部哨兵」的规则在三处各写一遍：单飞锁、游标、
 * 「回不满一页即到头」、失败即停止续取——改一处 bug 要改三处（且 ADR-046 的重复项问题
 * 就是在这种复制里漏掉的）。这里收敛为一处，页面只提供 `fetchPage(page)`。
 *
 * 约定：
 * - `fetchPage` 从 **1** 起取页；返回本页的**完整**结果。
 * - 回不满 `pageSize` 条即视为到头，不再观察哨兵。
 * - 跨页按 `keyOf` 去重（保留首次出现）。
 * - 续取失败停在当前结果、不自动重试；用户可整体重试（`reload`）。
 * - 依赖（如搜索词 / 类别）变化时自动重置到第 1 页。
 */
export interface PaginatedQuery<T> {
  items: T[]
  /** 首屏加载中（此时不应渲染列表）。 */
  loading: boolean
  /** 续页加载中（列表已显示，仅在底部显示加载态）。 */
  appending: boolean
  error: string | null
  /** 是否还有下一页（决定是否挂哨兵）。 */
  hasMore: boolean
  /** 当前已取到的页号（1 起；用于「没有更多了」的展示）。 */
  page: number
  /** 底部哨兵 ref：挂到列表末尾即可自动续页。 */
  sentinelRef: React.RefObject<HTMLDivElement | null>
  /** 手动续取一页（一般由哨兵触发）。 */
  loadMore: () => Promise<void>
  /** 从头重取（错误重试）。 */
  reload: () => void
}

export interface PaginatedQueryOptions<T> {
  /** 取第 `page` 页（从 1 起）。 */
  fetchPage: (page: number) => Promise<T[]>
  /** 每页条数；用于判断「是否还有下一页」。 */
  pageSize: number
  /** 依赖变化即重置（如搜索词 / 类别 / 音源）。 */
  deps: readonly unknown[]
  /** 身份键（默认用 `keyOf`，见 `@pterosaur/shared/types`）。 */
  keyOf: (item: T) => string
  /** 为 false 时不取数（如未输入关键词），返回空列表。 */
  enabled?: boolean
}

export function usePaginatedQuery<T>({
  fetchPage,
  pageSize,
  deps,
  keyOf,
  enabled = true,
}: PaginatedQueryOptions<T>): PaginatedQuery<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(enabled)
  const [appending, setAppending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)

  // 游标与单飞锁放在 ref：哨兵会背靠背触发，闭包里的 state 已是旧值
  const pageRef = useRef(1)
  const moreRef = useRef(false)
  const inflightRef = useRef(false)
  /** 世代号：依赖变化 / 重载后，旧请求的回包必须被丢弃。 */
  const genRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  /** 首屏：重置游标并取第 1 页。 */
  const loadFirst = useCallback(() => {
    const gen = ++genRef.current
    pageRef.current = 1
    moreRef.current = false
    inflightRef.current = false
    setPage(1)
    setHasMore(false)
    setAppending(false)
    setError(null)

    if (!enabled) {
      setItems([])
      setLoading(false)
      return
    }

    setLoading(true)
    fetchPage(1)
      .then((list) => {
        if (gen !== genRef.current) return
        setItems(dedupeByKey(list, keyOf))
        moreRef.current = list.length >= pageSize
        setHasMore(moreRef.current)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (gen !== genRef.current) return
        setError(e instanceof Error ? e.message : '加载失败')
        setLoading(false)
      })
    // fetchPage / keyOf 由调用方保证与 deps 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pageSize, enabled])

  useEffect(() => loadFirst(), [loadFirst])

  const loadMore = useCallback(async () => {
    if (!moreRef.current || inflightRef.current) return
    inflightRef.current = true
    const gen = genRef.current
    setAppending(true)
    const next = pageRef.current + 1
    try {
      const list = await fetchPage(next)
      if (gen !== genRef.current) return
      setItems((prev) => dedupeByKey([...prev, ...list], keyOf))
      moreRef.current = list.length >= pageSize
      pageRef.current = next
      setPage(next)
      setHasMore(moreRef.current)
    } catch {
      // 续取失败：停在当前结果，不继续观察哨兵（可整体重试）
      moreRef.current = false
      setHasMore(false)
    } finally {
      if (gen === genRef.current) {
        inflightRef.current = false
        setAppending(false)
      }
    }
  }, [fetchPage, keyOf, pageSize])

  // 滚动哨兵：进入视口即续取下一页（滚动容器是 .app-content，不是 window）
  useEffect(() => {
    if (!hasMore) return
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
  }, [hasMore, loadMore])

  return {
    items,
    loading,
    appending,
    error,
    hasMore,
    page,
    sentinelRef,
    loadMore,
    reload: loadFirst,
  }
}
