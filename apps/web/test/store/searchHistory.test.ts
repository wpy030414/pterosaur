import { describe, it, expect, beforeEach } from 'vitest'
import {
  useSearchHistory,
  SEARCH_HISTORY_MAX,
} from '../../src/store/searchHistory.js'

describe('useSearchHistory（最近搜索关键词）', () => {
  beforeEach(() => {
    useSearchHistory.setState({ terms: [] })
  })

  it('默认无历史词', () => {
    expect(useSearchHistory.getState().terms).toEqual([])
  })

  it('push 新词排在第一位', () => {
    useSearchHistory.getState().push('aaa')
    expect(useSearchHistory.getState().terms).toEqual(['aaa'])
  })

  it('push 重复词只置顶，不产生重复项', () => {
    const st = useSearchHistory.getState()
    st.push('aaa')
    st.push('bbb')
    st.push('aaa')
    expect(useSearchHistory.getState().terms).toEqual(['aaa', 'bbb'])
  })

  it('超出上限时淘汰最早的词', () => {
    const st = useSearchHistory.getState()
    for (let i = 0; i < SEARCH_HISTORY_MAX + 3; i++) st.push(`词${i}`)
    const terms = useSearchHistory.getState().terms
    expect(terms).toHaveLength(SEARCH_HISTORY_MAX)
    // 最早入栈的三条应被淘汰
    expect(terms).not.toContain('词0')
    expect(terms).not.toContain('词1')
    expect(terms).not.toContain('词2')
  })

  it('remove 删除指定词', () => {
    const st = useSearchHistory.getState()
    st.push('aaa')
    st.push('bbb')
    st.remove('aaa')
    expect(useSearchHistory.getState().terms).toEqual(['bbb'])
  })

  it('clear 清空全部', () => {
    const st = useSearchHistory.getState()
    st.push('aaa')
    st.push('bbb')
    st.clear()
    expect(useSearchHistory.getState().terms).toEqual([])
  })

  it('push 空串不生效', () => {
    const st = useSearchHistory.getState()
    st.push('')
    expect(useSearchHistory.getState().terms).toEqual([])
  })
})
