import { describe, it, expect } from 'vitest'
import { dedupeByKey } from '../../src/lib/dedupe.js'
import { keyOf } from '@pterosaur/shared/types'

const item = (source: string, id: string) => ({
  source: source as 'netease',
  id,
})

describe('dedupeByKey', () => {
  it('去掉重复项、保留首次出现与顺序', () => {
    const list = [
      item('netease', 'a'),
      item('netease', 'b'),
      item('netease', 'a'),
    ]
    expect(dedupeByKey(list, keyOf).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('同一原始 id 不同源不算重复（身份键含源）', () => {
    const list = [item('netease', '42'), item('bilibili', '42')]
    expect(dedupeByKey(list, keyOf)).toHaveLength(2)
  })

  it('无重复时原样返回（新数组）', () => {
    const list = [item('netease', 'a'), item('netease', 'b')]
    const out = dedupeByKey(list, keyOf)
    expect(out).toEqual(list)
    expect(out).not.toBe(list)
  })

  it('空列表安全', () => {
    expect(dedupeByKey([], keyOf)).toEqual([])
  })

  it('回归：模拟上游分页跨页重复（同 bvid 出现两页）', () => {
    const page1 = ['BV1p', 'BV1Ws411v7Zu', 'BV1kt'].map((id) => ({
      source: 'bilibili' as const,
      id,
    }))
    const page2 = ['BV1fa', 'BV1Ws411v7Zu', 'BV1ee'].map((id) => ({
      source: 'bilibili' as const,
      id,
    }))
    // 累积后再去重 —— 与 Search.tsx 的 `uniq([...prev, ...res])` 同构
    const acc = [...page1, ...page2]
    expect(acc).toHaveLength(6)
    expect(dedupeByKey(acc, keyOf)).toHaveLength(5)
  })
})
