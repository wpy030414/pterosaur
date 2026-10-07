import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  idbClear: vi.fn().mockResolvedValue(undefined),
  clearAllCaches: vi.fn().mockResolvedValue(undefined),
  unregisterServiceWorkers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lib/idb.js', () => ({
  LIBRARY_STORE: 'library',
  MEDIA_STORE: 'media',
  MEDIA_META_STORE: 'mediaMeta',
  idbClear: mocks.idbClear,
}))
vi.mock('../../src/lib/pwa.js', () => ({
  clearAllCaches: mocks.clearAllCaches,
  unregisterServiceWorkers: mocks.unregisterServiceWorkers,
}))

import { resetAll } from '../../src/lib/reset.js'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem('pterosaur-sync', 'x')
  sessionStorage.setItem('tmp', 'y')
})

describe('resetAll', () => {
  it('清空三个 IDB store / 缓存 / SW 注册 / Web Storage，并触发刷新', async () => {
    const reload = vi.fn()
    await resetAll({ reload })

    expect(mocks.idbClear.mock.calls.map((c) => c[0]).sort()).toEqual([
      'library',
      'media',
      'mediaMeta',
    ])
    expect(mocks.clearAllCaches).toHaveBeenCalledOnce()
    expect(mocks.unregisterServiceWorkers).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('某步清理失败不阻断其余清理与刷新', async () => {
    mocks.idbClear.mockRejectedValueOnce(new Error('boom'))
    const reload = vi.fn()
    await resetAll({ reload })

    expect(mocks.clearAllCaches).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
    expect(reload).toHaveBeenCalledOnce()
  })
})
