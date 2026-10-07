import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllAppCaches } from '../../src/lib/clearCaches.js'
import { clearMediaCache } from '../../src/lib/mediaCache.js'
import { clearLyricCache } from '../../src/lib/lyricCache.js'
import { clearCoverRegistry } from '../../src/lib/imageCache.js'
import { clearPrefetchRegistry } from '../../src/lib/prefetch.js'
import {
  clearAllCaches as clearCacheStorage,
  postToServiceWorker,
} from '../../src/lib/pwa.js'
import { clearAsyncCache } from '../../src/hooks/useAsync.js'

vi.mock('../../src/lib/mediaCache.js', () => ({ clearMediaCache: vi.fn() }))
vi.mock('../../src/lib/lyricCache.js', () => ({ clearLyricCache: vi.fn() }))
vi.mock('../../src/lib/imageCache.js', () => ({ clearCoverRegistry: vi.fn() }))
vi.mock('../../src/lib/prefetch.js', () => ({
  clearPrefetchRegistry: vi.fn(),
}))
vi.mock('../../src/lib/pwa.js', () => ({
  clearAllCaches: vi.fn().mockResolvedValue(undefined),
  postToServiceWorker: vi.fn(),
}))
vi.mock('../../src/hooks/useAsync.js', () => ({ clearAsyncCache: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(clearMediaCache).mockResolvedValue(undefined)
  vi.mocked(clearCacheStorage).mockResolvedValue(undefined)
})

describe('clearAllAppCaches', () => {
  it('清空媒体池 + 通知 SW + Cache Storage + 内存缓存', async () => {
    await clearAllAppCaches()
    expect(clearMediaCache).toHaveBeenCalledOnce()
    expect(postToServiceWorker).toHaveBeenCalledWith({
      type: 'MEDIA_CACHE_CLEARED',
    })
    expect(clearCacheStorage).toHaveBeenCalledOnce()
    expect(clearLyricCache).toHaveBeenCalledOnce()
    expect(clearCoverRegistry).toHaveBeenCalledOnce()
    expect(clearAsyncCache).toHaveBeenCalledOnce()
    expect(clearPrefetchRegistry).toHaveBeenCalledOnce()
  })

  it('媒体池清理抛错也不阻断其余清理', async () => {
    vi.mocked(clearMediaCache).mockRejectedValue(new Error('idb'))
    await expect(clearAllAppCaches()).resolves.toBeUndefined()
    expect(clearCacheStorage).toHaveBeenCalledOnce()
    expect(clearAsyncCache).toHaveBeenCalledOnce()
  })
})
