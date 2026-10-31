import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { usePaginatedQuery } from '../../src/hooks/usePaginatedQuery.js'

interface Row {
  id: string
  source: 'netease'
}

const row = (id: string): Row => ({ id, source: 'netease' })
const keyOf = (r: Row) => `${r.source}:${r.id}`

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePaginatedQuery', () => {
  it('首屏取第 1 页；整体重载可重置到第 1 页', async () => {
    const fetchPage = vi.fn(async (p: number) => [row(`${p}-a`), row(`${p}-b`)])
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({
        fetchPage,
        pageSize: 2,
        deps: [],
        keyOf,
      }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchPage).toHaveBeenLastCalledWith(1)
    expect(result.current.items.map((r) => r.id)).toEqual(['1-a', '1-b'])
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.reload())
    await waitFor(() => expect(fetchPage).toHaveBeenLastCalledWith(1))
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('续页追加并按身份键跨页去重', async () => {
    // 上游跨页重复（ADR-046 的真实情形）：第 2 页又回了 1-a
    const pages: Record<number, Row[]> = {
      1: [row('1-a'), row('1-b')],
      2: [row('1-a'), row('2-b')],
    }
    const fetchPage = vi.fn(async (p: number) => pages[p] ?? [])
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({ fetchPage, pageSize: 2, deps: [], keyOf }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.loadMore())
    expect(result.current.items.map((r) => r.id)).toEqual(['1-a', '1-b', '2-b'])
    expect(result.current.page).toBe(2)
  })

  it('回不满一页即到头，不再续取', async () => {
    const fetchPage = vi.fn(async (p: number) =>
      p === 1 ? [row('a'), row('b')] : [row('c')],
    )
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({ fetchPage, pageSize: 2, deps: [], keyOf }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(true)

    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(2)

    // 到头后手动再触发不产生请求
    await act(() => result.current.loadMore())
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('背靠背触发只有一次真正发出（单飞锁）', async () => {
    let release: (v: Row[]) => void = () => {}
    const fetchPage = vi.fn((p: number) =>
      p === 1
        ? Promise.resolve([row('a'), row('b')])
        : new Promise<Row[]>((r) => {
            release = r
          }),
    )
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({ fetchPage, pageSize: 2, deps: [], keyOf }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = result.current.loadMore()
      void result.current.loadMore() // 同一时刻的第二次触发
    })
    expect(fetchPage).toHaveBeenCalledTimes(2) // 首屏 + 一次续页
    await act(async () => {
      release([row('c'), row('d')])
      await first
    })
    expect(result.current.items).toHaveLength(4)
  })

  it('依赖变化时重置到第 1 页（旧请求回包被丢弃）', async () => {
    const fetchPage = vi.fn(async (p: number) => [row(`q${fetchPageQ}-${p}`)])
    let fetchPageQ = 'a'
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => {
        fetchPageQ = q
        return usePaginatedQuery<Row>({
          fetchPage,
          pageSize: 5,
          deps: [q],
          keyOf,
        })
      },
      { initialProps: { q: 'a' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items[0]?.id).toBe('qa-1')

    rerender({ q: 'b' })
    await waitFor(() => expect(result.current.items[0]?.id).toBe('qb-1'))
  })

  it('只取到部分结果后继续到末尾（依赖两页非满页）', async () => {
    const fetchPage = vi.fn(async (p: number) => [row(`${p}`)])
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({ fetchPage, pageSize: 1, deps: [], keyOf }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.loadMore())
    await act(() => result.current.loadMore())
    expect(result.current.items.map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  it('首屏失败给出错误，不抛未捕获异常', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom')
    })
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({ fetchPage, pageSize: 2, deps: [], keyOf }),
    )
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.loading).toBe(false)
  })

  it('enabled=false 时不取数', async () => {
    const fetchPage = vi.fn(async () => [row('x')])
    const { result } = renderHook(() =>
      usePaginatedQuery<Row>({
        fetchPage,
        pageSize: 2,
        deps: [],
        keyOf,
        enabled: false,
      }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchPage).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])
  })
})
