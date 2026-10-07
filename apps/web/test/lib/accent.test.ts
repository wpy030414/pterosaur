import { describe, expect, it } from 'vitest'
import { deriveAccent } from '../../src/lib/accent.js'

describe('deriveAccent', () => {
  it('对给定 hex 产出四个可用 CSS 值', () => {
    const a = deriveAccent('#3b6ea5')
    for (const v of [a.base, a.hover, a.press, a.soft]) {
      expect(v).toMatch(/^hsl\(/)
    }
    expect(a.soft).toContain('/ 0.14')
  })

  it('非法 / 缺省 hex 回落默认红且不抛错', () => {
    expect(() => deriveAccent('nonsense')).not.toThrow()
    expect(deriveAccent('nonsense').base).toMatch(/^hsl\(/)
  })

  it('派生色保留原色相（同色相不同明度的四档）', () => {
    const a = deriveAccent('#3b6ea5')
    const hue = (s: string) => s.match(/^hsl\((\d+)/)?.[1]
    expect(hue(a.base)).toBe(hue(a.hover))
    expect(hue(a.base)).toBe(hue(a.press))
    expect(hue(a.base)).toBe(hue(a.soft))
  })
})
