import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pickPlaybackSrc } from '../../src/lib/offlineAudio.js'

/**
 * 离线播放的选源规则（纯函数部分）。真正的 `<audio>` / IDB 交互由 e2e 覆盖，
 * 这里锁定「离线且已保存才用 blob」这一条语义。
 */
describe('pickPlaybackSrc', () => {
  const stream = '/stream/netease/1?level=exhigh'
  const blob = 'blob:local-1'

  it('在线：永远用流地址（浏览器 HTTP 缓存负责省流）', () => {
    expect(pickPlaybackSrc(true, null, stream)).toBe(stream)
    expect(pickPlaybackSrc(true, blob, stream)).toBe(stream)
  })

  it('离线且已保存：用本地 blob', () => {
    expect(pickPlaybackSrc(false, blob, stream)).toBe(blob)
  })

  it('离线未保存：仍返回流地址（交由上层给出明确提示，而不是静默失败）', () => {
    expect(pickPlaybackSrc(false, null, stream)).toBe(stream)
  })

  it('没有当前曲（流地址为空）时原样返回空', () => {
    expect(pickPlaybackSrc(false, blob, '')).toBe('')
    expect(pickPlaybackSrc(true, null, '')).toBe('')
  })
})

const idb = vi.hoisted(() => ({
  getSaved: vi.fn(),
  removeSaved: vi.fn(),
}))

vi.mock('../../src/lib/mediaCache.js', () => ({
  audioKey: (s: string, id: string, level: string) => `${s}:${id}|${level}`,
  getSaved: idb.getSaved,
  removeSaved: idb.removeSaved,
}))
vi.mock('../../src/lib/cacheRegistry.js', () => ({
  registerCacheCleaner: vi.fn(),
}))

const { heldObjectUrls, lookupSavedAudio, releaseSavedUrls, removeSavedAudio } =
  await import('../../src/lib/offlineAudio.js')

describe('离线副本的 object URL 管理', () => {
  const createObjectURL = vi.fn<() => string>()
  const revokeObjectURL = vi.fn<(url: string) => void>()

  beforeEach(() => {
    idb.getSaved.mockReset()
    idb.removeSaved.mockReset().mockResolvedValue(undefined)
    releaseSavedUrls()
    createObjectURL.mockReset()
    revokeObjectURL.mockReset()
    let n = 0
    createObjectURL.mockImplementation(() => `blob:mock-${++n}`)
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })

  it('未保存返回 null，不建 URL', async () => {
    idb.getSaved.mockResolvedValue(null)
    expect(await lookupSavedAudio('netease', '1', 'exhigh')).toBeNull()
    expect(heldObjectUrls()).toBe(0)
  })

  it('命中时建 URL，重复查询复用同一个（不重复建）', async () => {
    idb.getSaved.mockResolvedValue({ meta: {}, blob: new Blob(['x']) })
    const a = await lookupSavedAudio('netease', '1', 'exhigh')
    const b = await lookupSavedAudio('netease', '1', 'exhigh')
    expect(a).toBe('blob:mock-1')
    expect(b).toBe(a)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('releaseSavedUrls 吊销全部 URL 并清空', async () => {
    idb.getSaved.mockResolvedValue({ meta: {}, blob: new Blob(['x']) })
    const a = await lookupSavedAudio('netease', '1', 'exhigh')
    releaseSavedUrls()
    expect(revokeObjectURL).toHaveBeenCalledWith(a)
    expect(heldObjectUrls()).toBe(0)
  })

  it('删除离线副本时同时吊销其 URL 与 IDB 条目', async () => {
    idb.getSaved.mockResolvedValue({ meta: {}, blob: new Blob(['x']) })
    const a = await lookupSavedAudio('netease', '2', 'exhigh')
    await removeSavedAudio('netease', '2', 'exhigh')
    expect(revokeObjectURL).toHaveBeenCalledWith(a)
    expect(idb.removeSaved).toHaveBeenCalledWith(['netease:2|exhigh'])
  })
})
