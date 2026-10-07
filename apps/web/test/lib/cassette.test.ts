import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@pterosaur/shared/types'
import { api } from '../../src/api/client.js'
import {
  expandGroups,
  expandList,
  expandTrack,
} from '../../src/lib/cassette.js'

vi.mock('../../src/api/client.js', () => ({ api: { parts: vi.fn() } }))

const t = (over: Partial<Track>): Track => ({
  source: 'netease',
  id: '1',
  title: 't',
  artist: 'a',
  album: '',
  cover: '',
  duration: 0,
  fee: 'free',
  ...over,
})

beforeEach(() => {
  vi.mocked(api.parts).mockReset()
})

describe('expandTrack', () => {
  it('非 B 站源 → 原样单项，且不发请求', async () => {
    const r = await expandTrack(t({}))
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('1')
    expect(api.parts).not.toHaveBeenCalled()
  })

  it('B 站裸 bvid → 展开为分P', async () => {
    vi.mocked(api.parts).mockResolvedValue([
      t({ source: 'bilibili', id: 'BV1:1' }),
      t({ source: 'bilibili', id: 'BV1:2' }),
    ])
    const r = await expandTrack(t({ source: 'bilibili', id: 'BV1' }))
    expect(r.map((x) => x.id)).toEqual(['BV1:1', 'BV1:2'])
    expect(api.parts).toHaveBeenCalledWith('bilibili', 'BV1')
  })

  it('已是分P 条目（id 含 `:`）→ 不重复展开', async () => {
    const r = await expandTrack(t({ source: 'bilibili', id: 'BV1:1' }))
    expect(r).toHaveLength(1)
    expect(api.parts).not.toHaveBeenCalled()
  })

  it('展开失败 → 降级为原条目，不抛出', async () => {
    vi.mocked(api.parts).mockRejectedValue(new Error('boom'))
    const r = await expandTrack(t({ source: 'bilibili', id: 'BV1' }))
    expect(r.map((x) => x.id)).toEqual(['BV1'])
  })

  it('返回空数组 → 降级为原条目', async () => {
    vi.mocked(api.parts).mockResolvedValue([])
    const r = await expandTrack(t({ source: 'bilibili', id: 'BV1' }))
    expect(r.map((x) => x.id)).toEqual(['BV1'])
  })
})

describe('expandGroups / expandList', () => {
  it('保留分组以便推算起始下标；扁平化后顺序不变', async () => {
    vi.mocked(api.parts).mockResolvedValue([
      t({ source: 'bilibili', id: 'BV1:1' }),
      t({ source: 'bilibili', id: 'BV1:2' }),
    ])
    const list = [
      t({ id: 'a' }),
      t({ source: 'bilibili', id: 'BV1' }),
      t({ id: 'b' }),
    ]
    const groups = await expandGroups(list)
    expect(groups.map((g) => g.length)).toEqual([1, 2, 1])
    expect((await expandList(list)).map((x) => x.id)).toEqual([
      'a',
      'BV1:1',
      'BV1:2',
      'b',
    ])
  })
})
