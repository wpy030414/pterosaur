import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COVER_LARGE, COVER_SMALL, coverAt } from '@pterosaur/shared/image'
import { keyOf, type Track } from '@pterosaur/shared/types'
import {
  PREFETCH_COVER_PXES,
  canPrefetch,
  clearPrefetchRegistry,
  createPrefetchScheduler,
  hasPrefetched,
  isNetworkGood,
  markPrefetched,
  prefetchKey,
  prefetchTargets,
  prefetchTrack,
} from '../../src/lib/prefetch.js'
import { audioKey } from '../../src/lib/mediaCache.js'
import { postToServiceWorker } from '../../src/lib/pwa.js'
import { preloadCover } from '../../src/lib/imageCache.js'
import { prefetchLyric } from '../../src/lib/lyricCache.js'

vi.mock('../../src/lib/pwa.js', () => ({ postToServiceWorker: vi.fn() }))
vi.mock('../../src/lib/imageCache.js', () => ({ preloadCover: vi.fn() }))
vi.mock('../../src/lib/lyricCache.js', () => ({
  prefetchLyric: vi.fn().mockResolvedValue(undefined),
}))

/** 使用网易云镜像主机，使 `coverAt` 能按尺寸改写出两个不同 URL。 */
const NET_COVER = 'https://p1.music.126.net/abc/cover.jpg'

function track(id: string, cover = NET_COVER): Track {
  return {
    source: 'netease',
    id,
    title: `曲目${id}`,
    artist: '艺人',
    album: '专辑',
    cover,
    duration: 100,
    fee: 'free',
  }
}

const Q5 = [track('1'), track('2'), track('3'), track('4'), track('5')]

afterEach(() => vi.useRealTimers())

describe('prefetchTargets', () => {
  it('长队列取前后各 2 首、不含当前曲，顺序为 +1,-1,+2,-2', () => {
    // index 2：+1→'4'，-1→'2'，+2→'5'，-2→'1'
    expect(prefetchTargets(Q5, 2).map((t) => t.id)).toEqual([
      '4',
      '2',
      '5',
      '1',
    ])
  })

  it('index 0 时向前回绕到队尾', () => {
    // +1→'2'，-1→'5'，+2→'3'，-2→'4'
    expect(prefetchTargets(Q5, 0).map((t) => t.id)).toEqual([
      '2',
      '5',
      '3',
      '4',
    ])
  })

  it('短队列回绕去重：len1→0，len2→1，len3→2，len4→3', () => {
    expect(prefetchTargets([track('1')], 0)).toEqual([])
    expect(prefetchTargets(Q5.slice(0, 2), 0).map((t) => t.id)).toEqual(['2'])
    expect(prefetchTargets(Q5.slice(0, 3), 0).map((t) => t.id)).toEqual([
      '2',
      '3',
    ])
    expect(prefetchTargets(Q5.slice(0, 4), 0).map((t) => t.id)).toEqual([
      '2',
      '4',
      '3',
    ])
  })

  it('队列含重复曲目 → 按 keyOf 去重', () => {
    const dup = [track('1'), track('2'), track('2'), track('3')]
    const r = prefetchTargets(dup, 0)
    expect(new Set(r.map(keyOf)).size).toBe(r.length)
  })

  it('index 越界或队列过短 → 空', () => {
    expect(prefetchTargets(Q5, -1)).toEqual([])
    expect(prefetchTargets(Q5, 5)).toEqual([])
    expect(prefetchTargets([], 0)).toEqual([])
  })
})

describe('isNetworkGood', () => {
  it('离线 → false', () => expect(isNetworkGood(false)).toBe(false))
  it('无 connection 信息 → true', () => expect(isNetworkGood(true)).toBe(true))
  it('省流模式 → false', () =>
    expect(isNetworkGood(true, { saveData: true })).toBe(false))
  it('4g → true', () =>
    expect(isNetworkGood(true, { effectiveType: '4g' })).toBe(true))
  it('慢速类型 → false', () => {
    expect(isNetworkGood(true, { effectiveType: 'slow-2g' })).toBe(false)
    expect(isNetworkGood(true, { effectiveType: '2g' })).toBe(false)
    expect(isNetworkGood(true, { effectiveType: '3g' })).toBe(false)
  })
  it('未知类型 → true（保守放行）', () =>
    expect(isNetworkGood(true, { effectiveType: '5g' })).toBe(true))
})

describe('canPrefetch', () => {
  const base = { online: true, buffering: false, readyState: 4 }
  it('缓冲中 → false', () =>
    expect(canPrefetch({ ...base, buffering: true })).toBe(false))
  it('readyState < 3 → false', () =>
    expect(canPrefetch({ ...base, readyState: 2 })).toBe(false))
  it('就绪 + 网络良好 → true', () => expect(canPrefetch(base)).toBe(true))
  it('就绪但网络差 → false', () =>
    expect(canPrefetch({ ...base, connection: { effectiveType: '3g' } })).toBe(
      false,
    ))
})

describe('预载去重表', () => {
  beforeEach(() => clearPrefetchRegistry())

  it('prefetchKey 与 SW 的 audioKey 同形', () => {
    expect(prefetchKey(track('7'), 'hires')).toBe(
      audioKey('netease', '7', 'hires'),
    )
  })

  it('按 key（含 level）区分', () => {
    const t = track('1')
    expect(hasPrefetched(t, 'exhigh')).toBe(false)
    markPrefetched(t, 'exhigh')
    expect(hasPrefetched(t, 'exhigh')).toBe(true)
    expect(hasPrefetched(t, 'lossless')).toBe(false)
  })

  it('clearPrefetchRegistry 清空', () => {
    markPrefetched(track('1'), 'exhigh')
    clearPrefetchRegistry()
    expect(hasPrefetched(track('1'), 'exhigh')).toBe(false)
  })
})

describe('prefetchTrack', () => {
  beforeEach(() => {
    clearPrefetchRegistry()
    vi.clearAllMocks()
  })

  it('发 SW 消息 + 两档封面 + 歌词，重复调用不重发', () => {
    const t = track('9')
    prefetchTrack(t, 'exhigh')

    expect(postToServiceWorker).toHaveBeenCalledWith({
      type: 'PREFETCH_AUDIO',
      source: 'netease',
      id: '9',
      level: 'exhigh',
    })
    expect(preloadCover).toHaveBeenCalledTimes(PREFETCH_COVER_PXES.length)
    expect(preloadCover).toHaveBeenCalledWith(coverAt(t.cover, COVER_SMALL))
    expect(preloadCover).toHaveBeenCalledWith(coverAt(t.cover, COVER_LARGE))
    expect(prefetchLyric).toHaveBeenCalledWith(t)

    // 幂等：已预载不再重发
    prefetchTrack(t, 'exhigh')
    expect(postToServiceWorker).toHaveBeenCalledTimes(1)
    expect(preloadCover).toHaveBeenCalledTimes(PREFETCH_COVER_PXES.length)
  })

  it('换档位后按新档重发', () => {
    const t = track('9')
    prefetchTrack(t, 'exhigh')
    prefetchTrack(t, 'lossless')
    expect(postToServiceWorker).toHaveBeenCalledTimes(2)
  })
})

describe('createPrefetchScheduler', () => {
  /** 同步 idle：调用即执行，便于确定性断言。 */
  const syncIdle = (cb: () => void): number => {
    cb()
    return 0
  }

  it('静置期满后才串行执行全部目标', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const s = createPrefetchScheduler({
      gate: () => true,
      run,
      idle: syncIdle,
      cancelIdle: () => {},
      settleMs: 100,
    })
    s.schedule([track('1'), track('2'), track('3')], 'exhigh')
    expect(run).not.toHaveBeenCalled() // 静置期内不发车
    vi.advanceTimersByTime(100)
    expect(run.mock.calls.map((c) => (c[0] as Track).id)).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  it('gate 中途转 false → 停止后续', () => {
    vi.useFakeTimers()
    let ok = true
    const run = vi.fn(() => {
      ok = false
    })
    const s = createPrefetchScheduler({
      gate: () => ok,
      run,
      idle: syncIdle,
      cancelIdle: () => {},
      settleMs: 10,
    })
    s.schedule([track('1'), track('2'), track('3')], 'exhigh')
    vi.advanceTimersByTime(10)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('静置期内重复 schedule → 前一轮从不发车', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const s = createPrefetchScheduler({
      gate: () => true,
      run,
      idle: syncIdle,
      cancelIdle: () => {},
      settleMs: 100,
    })
    s.schedule([track('1')], 'exhigh')
    vi.advanceTimersByTime(50)
    s.schedule([track('2')], 'exhigh')
    vi.advanceTimersByTime(100)
    expect(run.mock.calls.map((c) => (c[0] as Track).id)).toEqual(['2'])
  })

  it('cancel 后不再执行', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const s = createPrefetchScheduler({
      gate: () => true,
      run,
      idle: syncIdle,
      cancelIdle: () => {},
      settleMs: 100,
    })
    s.schedule([track('1')], 'exhigh')
    s.cancel()
    vi.advanceTimersByTime(300)
    expect(run).not.toHaveBeenCalled()
  })

  it('默认 idle 在无 requestIdleCallback 时退化为 setTimeout', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    // 不注入 idle：走默认路径（jsdom 无 requestIdleCallback → setTimeout）
    const s = createPrefetchScheduler({
      gate: () => true,
      run,
      settleMs: 10,
      gapMs: 10,
    })
    s.schedule([track('1'), track('2')], 'exhigh')
    vi.advanceTimersByTime(10) // settle 到期 → 第一首
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10) // gap 到期 → 第二首
    expect(run).toHaveBeenCalledTimes(2)
  })
})
