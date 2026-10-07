import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lyric, Track } from '@pterosaur/shared/types'

vi.mock('../../src/api/client.js', () => ({ api: { lyric: vi.fn() } }))

import { api } from '../../src/api/client.js'
import {
  clearLyricCache,
  getCachedLyric,
  prefetchLyric,
  putCachedLyric,
} from '../../src/lib/lyricCache.js'

const lyricMock = api.lyric as unknown as ReturnType<typeof vi.fn>
const sample: Lyric = { lines: [{ time: 0, text: 'hi' }], timed: true }
const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: '',
  artist: '',
  album: '',
  cover: '',
  duration: 0,
  fee: 'free',
})

beforeEach(() => {
  clearLyricCache()
  lyricMock.mockReset()
})

describe('lyricCache', () => {
  it('未缓存返回 null', () => {
    expect(getCachedLyric(track('a'))).toBeNull()
  })

  it('put 后可读', () => {
    putCachedLyric(track('a'), sample)
    expect(getCachedLyric(track('a'))).toBe(sample)
  })

  it('prefetch 拉取并写入缓存', async () => {
    lyricMock.mockResolvedValue(sample)
    await prefetchLyric(track('a'))
    expect(lyricMock).toHaveBeenCalledWith('netease', 'a')
    expect(getCachedLyric(track('a'))).toBe(sample)
  })

  it('命中缓存不再请求', async () => {
    putCachedLyric(track('a'), sample)
    await prefetchLyric(track('a'))
    expect(lyricMock).not.toHaveBeenCalled()
  })

  it('并发预取同一曲目只发一次请求（in-flight 去重）', async () => {
    lyricMock.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(sample), 5)),
    )
    await Promise.all([prefetchLyric(track('a')), prefetchLyric(track('a'))])
    expect(lyricMock).toHaveBeenCalledTimes(1)
    expect(getCachedLyric(track('a'))).toBe(sample)
  })

  it('请求失败不污染缓存，之后可重试', async () => {
    lyricMock.mockRejectedValue(new Error('boom'))
    await prefetchLyric(track('a'))
    expect(getCachedLyric(track('a'))).toBeNull()

    lyricMock.mockResolvedValue(sample)
    await prefetchLyric(track('a'))
    expect(getCachedLyric(track('a'))).toBe(sample)
  })

  it('超过上限按插入顺序淘汰最旧', () => {
    for (let i = 0; i < 70; i++) putCachedLyric(track(`k${i}`), sample)
    expect(getCachedLyric(track('k0'))).toBeNull()
    expect(getCachedLyric(track('k69'))).toBe(sample)
  })

  it('不同曲目 id 不互相串歌词', () => {
    putCachedLyric(track('1'), sample)
    expect(getCachedLyric(track('2'))).toBeNull()
  })
})
