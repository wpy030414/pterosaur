import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@pterosaur/shared/types'
import {
  SAVE_GAP_MS,
  collectionState,
  removeOffline,
  saveTrackOffline,
  saveTracks,
} from '../../src/lib/offline.js'

const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: `曲目 ${id}`,
  artist: '艺术家',
  album: '专辑',
  cover: '',
  duration: 0,
  fee: 'free',
})

const jsonRes = (status: number, type = 'audio/mpeg') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => (k === 'content-type' ? type : null) },
  blob: () => Promise.resolve(new Blob([new Uint8Array(8)])),
  body: { cancel: () => Promise.resolve() },
})

const store = vi.hoisted(() => ({
  hasSavedAudio: vi.fn(),
  saveAudio: vi.fn(),
  getSaved: vi.fn(),
  getAllMeta: vi.fn(),
  removeSaved: vi.fn(),
  saveReasonOf: vi.fn(),
}))

vi.mock('../../src/lib/mediaCache.js', () => ({
  audioKey: (s: string, id: string, level: string) => `${s}:${id}|${level}`,
  hasSavedAudio: store.hasSavedAudio,
  saveAudio: store.saveAudio,
  getSaved: store.getSaved,
  getAllMeta: store.getAllMeta,
  removeSaved: store.removeSaved,
  saveReasonOf: store.saveReasonOf,
}))

beforeEach(() => {
  vi.clearAllMocks()
  store.hasSavedAudio.mockResolvedValue(false)
  store.saveAudio.mockResolvedValue(undefined)
  store.getAllMeta.mockResolvedValue([])
  store.removeSaved.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn())
})

describe('saveTrackOffline', () => {
  it('下载整曲并以 explicit 写入 IDB', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRes(200) as never)
    const r = await saveTrackOffline(track('1'), 'exhigh')

    expect(r).toEqual({ kind: 'saved' })
    expect(fetch).toHaveBeenCalledWith(
      '/stream/netease/1?level=exhigh',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(store.saveAudio).toHaveBeenCalledWith(
      'netease',
      '1',
      'exhigh',
      expect.any(Blob),
      'audio/mpeg',
      'explicit',
    )
  })

  it('已保存（如自动预取）时只把来源升级为 explicit，不重新下载', async () => {
    store.hasSavedAudio.mockResolvedValue(true)
    store.getSaved.mockResolvedValue({
      meta: {
        key: 'netease:1|exhigh',
        kind: 'audio',
        mime: 'audio/mpeg',
        size: 8,
        lastAccess: 42,
      },
      blob: new Blob(['x']),
    })
    const r = await saveTrackOffline(track('1'), 'exhigh')

    expect(r).toEqual({ kind: 'saved' })
    expect(fetch).not.toHaveBeenCalled()
    expect(store.saveAudio).toHaveBeenCalledWith(
      'netease',
      '1',
      'exhigh',
      expect.any(Blob),
      'audio/mpeg',
      'explicit',
      42,
    )
  })

  it('403 → needLogin（VIP / 版权受限），不写库', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRes(403) as never)
    expect(await saveTrackOffline(track('1'), 'exhigh')).toEqual({
      kind: 'needLogin',
    })
    expect(store.saveAudio).not.toHaveBeenCalled()
  })

  it('网络异常 / 非音频 / 空体 → failed，不写库', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('net'))
    expect((await saveTrackOffline(track('1'))).kind).toBe('failed')

    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(200, 'text/html') as never)
    expect((await saveTrackOffline(track('1'))).kind).toBe('failed')

    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(500) as never)
    expect((await saveTrackOffline(track('1'))).kind).toBe('failed')
    expect(store.saveAudio).not.toHaveBeenCalled()
  })
})

describe('saveTracks', () => {
  it('逐首保存并汇总进度（成功 / 需登录 / 失败分开计数）', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonRes(200) as never)
      .mockResolvedValueOnce(jsonRes(403) as never)
      .mockRejectedValueOnce(new Error('boom'))

    const onProgress = vi.fn()
    const p = saveTracks(
      [track('1'), track('2'), track('3')],
      'exhigh',
      onProgress,
      undefined,
    )
    await vi.advanceTimersByTimeAsync(SAVE_GAP_MS * 4)
    expect(await p).toMatchObject({
      total: 3,
      done: 3,
      saved: 1,
      needLogin: 1,
      failed: 1,
    })
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ done: 3 })
    vi.useRealTimers()
  })

  it('取消后停止后续下载，已完成的保留', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(jsonRes(200) as never),
    )
    const ctrl = new AbortController()
    // 并发上限 2：前两首立即处理，其余在间隔里等待
    const p = saveTracks(
      [track('1'), track('2'), track('3'), track('4')],
      'exhigh',
      undefined,
      ctrl.signal,
    )
    await vi.advanceTimersByTimeAsync(1)
    ctrl.abort()
    // 中止后不再安排新的间隔等待，promise 应在本轮收敛
    await vi.advanceTimersByTimeAsync(SAVE_GAP_MS * 3)
    const result = await p
    // 只剩在途的 2 首收尾，排在后面的 2 首不再开始
    expect(result.done).toBe(2)
    expect(store.saveAudio).toHaveBeenCalledTimes(result.saved)
    vi.useRealTimers()
  })
})

describe('collectionState / removeOffline', () => {
  const metas = [
    { key: 'netease:1|exhigh', kind: 'audio', source: 'netease', trackId: '1' },
    { key: 'netease:2|exhigh', kind: 'audio', source: 'netease', trackId: '2' },
  ]

  it('全部 / 部分 / 未保存', async () => {
    store.getAllMeta.mockResolvedValue(metas)
    expect(await collectionState([track('1'), track('2')], 'exhigh')).toBe(
      'all',
    )
    expect(await collectionState([track('1'), track('9')], 'exhigh')).toBe(
      'partial',
    )
    expect(await collectionState([track('9')], 'exhigh')).toBe('none')
    expect(await collectionState([], 'exhigh')).toBe('none')
  })

  it('removeOffline 只删集合内的曲目（按 source+id，不区分档位）', async () => {
    store.getAllMeta.mockResolvedValue(metas)
    await removeOffline([track('2')])
    expect(store.removeSaved).toHaveBeenCalledWith(['netease:2|exhigh'])
  })
})
