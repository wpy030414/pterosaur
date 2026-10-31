import { describe, expect, it, vi } from 'vitest'
import {
  clearRegisteredCaches,
  registerCacheCleaner,
  registeredCacheCount,
} from '../../src/lib/cacheRegistry.js'

describe('cacheRegistry', () => {
  it('登记后统一清理，可注销', () => {
    const a = vi.fn()
    const off = registerCacheCleaner(a)
    const before = registeredCacheCount()
    clearRegisteredCaches()
    expect(a).toHaveBeenCalled()

    off()
    expect(registeredCacheCount()).toBe(before - 1)
    a.mockClear()
    clearRegisteredCaches()
    expect(a).not.toHaveBeenCalled()
  })

  it('单个清理函数抛错不阻断其余', () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    const offBad = registerCacheCleaner(bad)
    const offGood = registerCacheCleaner(good)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clearRegisteredCaches()
    expect(good).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    offBad()
    offGood()
    warn.mockRestore()
  })
})
