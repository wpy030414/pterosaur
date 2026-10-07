import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkForUpdates,
  clearAllCaches,
  hardReload,
  postToServiceWorker,
  unregisterServiceWorkers,
} from '../../src/lib/pwa.js'

afterEach(() => vi.unstubAllGlobals())

describe('unregisterServiceWorkers', () => {
  it('注销全部注册', async () => {
    const unregister = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi
          .fn()
          .mockResolvedValue([{ unregister }, { unregister }]),
      },
    })
    await unregisterServiceWorkers()
    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('无 serviceWorker 支持时静默返回', async () => {
    vi.stubGlobal('navigator', {})
    await expect(unregisterServiceWorkers()).resolves.toBeUndefined()
  })
})

describe('clearAllCaches', () => {
  it('删除全部 cache key', async () => {
    const del = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['a', 'b']),
      delete: del,
    })
    await clearAllCaches()
    expect(del).toHaveBeenCalledWith('a')
    expect(del).toHaveBeenCalledWith('b')
  })

  it('无 caches 时静默返回', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(clearAllCaches()).resolves.toBeUndefined()
  })
})

describe('hardReload', () => {
  it('先绕过 HTTP 缓存重取文档再刷新', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    const reload = vi.fn()
    await hardReload(reload)
    expect(fetchSpy).toHaveBeenCalledWith(location.href, { cache: 'reload' })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('重取失败仍刷新', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const reload = vi.fn()
    await hardReload(reload)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('checkForUpdates', () => {
  it('注销 + 清缓存 + 硬刷新，且不碰 IndexedDB', async () => {
    const unregister = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      },
    })
    const del = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['x']),
      delete: del,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const reload = vi.fn()

    await checkForUpdates(reload)

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('x')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('postToServiceWorker', () => {
  it('向 controller 广播消息', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('navigator', {
      serviceWorker: { controller: { postMessage } },
    })
    postToServiceWorker({ type: 'MEDIA_CACHE_CLEARED' })
    expect(postMessage).toHaveBeenCalledWith({ type: 'MEDIA_CACHE_CLEARED' })
  })

  it('无 controller 时静默', () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } })
    expect(() => postToServiceWorker({ type: 'x' })).not.toThrow()
  })
})
