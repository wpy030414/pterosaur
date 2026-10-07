import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearScrollMemory,
  saveCurrentScroll,
  savedScroll,
  setCurrentScrollKey,
} from '../../src/lib/scrollMemory.js'

beforeEach(() => {
  clearScrollMemory()
})

describe('scrollMemory', () => {
  it('按当前条目 key 记录与读取', () => {
    setCurrentScrollKey('k1')
    saveCurrentScroll(420)
    expect(savedScroll('k1')).toBe(420)
  })

  it('未设置当前 key 时忽略写入', () => {
    saveCurrentScroll(420)
    expect(savedScroll('k1')).toBe(0)
  })

  it('切换 key 后写入归属新条目', () => {
    setCurrentScrollKey('k1')
    saveCurrentScroll(100)
    setCurrentScrollKey('k2')
    saveCurrentScroll(200)
    expect(savedScroll('k1')).toBe(100)
    expect(savedScroll('k2')).toBe(200)
  })

  it('未知条目回退 0、负值归零', () => {
    expect(savedScroll('missing')).toBe(0)
    setCurrentScrollKey('k3')
    saveCurrentScroll(-5)
    expect(savedScroll('k3')).toBe(0)
  })
})
