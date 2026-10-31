import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  clearAsyncCache,
  invalidateAsyncCache,
  useAsync,
} from '../../src/hooks/useAsync.js'

afterEach(() => {
  clearAsyncCache()
  vi.useRealTimers()
})

/** 让所有挂起的微任务跑完。 */
const flush = () => act(async () => {})

describe('useAsync 缓存', () => {
  it('同一 cacheKey 再次挂载时同步命中缓存、不再请求、无加载态', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    const first = renderHook(() => useAsync(fetcher, [], null, 'k:1'))
    await waitFor(() => expect(first.result.current.data).toEqual({ v: 1 }))
    expect(fetcher).toHaveBeenCalledTimes(1)

    const second = renderHook(() => useAsync(fetcher, [], null, 'k:1'))
    // 首次渲染即拿到缓存值，且不计入 loading
    expect(second.result.current.data).toEqual({ v: 1 })
    expect(second.result.current.loading).toBe(false)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2) // 后台仍会刷新一次，但界面不闪烁
  })

  it('失败结果不写缓存', async () => {
    const fetcher = vi
      .fn<() => Promise<{ v: number }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ v: 2 })
    const first = renderHook(() => useAsync(fetcher, [], null, 'k:err'))
    await waitFor(() => expect(first.result.current.error).toBe('boom'))

    const second = renderHook(() => useAsync(fetcher, [], null, 'k:err'))
    expect(second.result.current.loading).toBe(true) // 未命中缓存
  })

  it('reload（用户重试）跳过缓存直读网络', async () => {
    let n = 0
    const fetcher = vi.fn(async () => ({ v: ++n }))
    const { result } = renderHook(() => useAsync(fetcher, [], null, 'k:r'))
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }))

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidateAsyncCache 按前缀失效', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    const first = renderHook(() => useAsync(fetcher, [], null, 'playlist:a:1'))
    await waitFor(() => expect(first.result.current.data).toEqual({ v: 1 }))
    first.unmount()

    act(() => invalidateAsyncCache('playlist:'))
    const again = renderHook(() => useAsync(fetcher, [], null, 'playlist:a:1'))
    expect(again.result.current.loading).toBe(true)
  })

  it('超过容量上限淘汰最久未用的条目', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }))
    // 写入 61 条（上限 60），第一条应被淘汰
    for (let i = 0; i < 61; i++) {
      const h = renderHook(() => useAsync(fetcher, [], null, `cap:${i}`))
      await waitFor(() => expect(h.result.current.data).toEqual({ v: 1 }))
      h.unmount()
    }
    const oldest = renderHook(() => useAsync(fetcher, [], null, 'cap:0'))
    expect(oldest.result.current.loading).toBe(true) // 已淘汰 → 未命中
    const newest = renderHook(() => useAsync(fetcher, [], null, 'cap:60'))
    expect(newest.result.current.loading).toBe(false) // 最近写入 → 命中
  })

  it('TTL 到期后视为未命中', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetcher = vi.fn(async () => ({ v: 1 }))
    const first = renderHook(() => useAsync(fetcher, [], null, 'ttl:1'))
    await act(async () => {})
    expect(first.result.current.data).toEqual({ v: 1 })
    first.unmount()

    vi.setSystemTime(Date.now() + 6 * 60_000)
    const again = renderHook(() => useAsync(fetcher, [], null, 'ttl:1'))
    expect(again.result.current.loading).toBe(true)
  })
})
