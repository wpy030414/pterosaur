import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllAppCaches } from '../../src/lib/clearCaches.js'
import { clearOfflineAudio } from '../../src/lib/mediaCache.js'
import {
  clearAllCaches as clearCacheStorage,
  postToServiceWorker,
} from '../../src/lib/pwa.js'
import { clearRegisteredCaches } from '../../src/lib/cacheRegistry.js'

vi.mock('../../src/lib/mediaCache.js', () => ({ clearOfflineAudio: vi.fn() }))
vi.mock('../../src/lib/pwa.js', () => ({
  clearAllCaches: vi.fn().mockResolvedValue(undefined),
  postToServiceWorker: vi.fn(),
}))
vi.mock('../../src/lib/cacheRegistry.js', () => ({
  clearRegisteredCaches: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(clearOfflineAudio).mockResolvedValue(undefined)
  vi.mocked(clearCacheStorage).mockResolvedValue(undefined)
})

describe('clearAllAppCaches', () => {
  it('清空媒体池 + 通知 SW + Cache Storage + 登记过的内存缓存', async () => {
    await clearAllAppCaches()
    expect(clearOfflineAudio).toHaveBeenCalledOnce()
    expect(postToServiceWorker).toHaveBeenCalledWith({
      type: 'MEDIA_CACHE_CLEARED',
    })
    expect(clearCacheStorage).toHaveBeenCalledOnce()
    // 内存缓存不再逐个硬编码调用：各模块自注册，此处统一遍历
    expect(clearRegisteredCaches).toHaveBeenCalledOnce()
  })

  it('媒体池清理抛错也不阻断其余清理', async () => {
    vi.mocked(clearOfflineAudio).mockRejectedValue(new Error('idb'))
    await expect(clearAllAppCaches()).resolves.toBeUndefined()
    expect(clearCacheStorage).toHaveBeenCalledOnce()
    expect(clearRegisteredCaches).toHaveBeenCalledOnce()
  })
})
