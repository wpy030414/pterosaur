import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAccentFromBackground } from '../../src/hooks/useAccentFromBackground.js'
import { useSettings } from '../../src/store/settings.js'

const VARS = [
  '--accent',
  '--accent-hover',
  '--accent-press',
  '--accent-soft',
] as const

function varsOnRoot(): string[] {
  return VARS.map((v) => document.documentElement.style.getPropertyValue(v))
}

describe('useAccentFromBackground', () => {
  beforeEach(() => {
    useSettings.setState({ background: null })
  })

  afterEach(() => {
    useSettings.setState({ background: null })
    for (const v of VARS) document.documentElement.style.removeProperty(v)
  })

  it('有取色结果时覆写四档强调色', () => {
    useSettings.setState({
      background: { kind: 'image', mime: 'image/png', accent: '#3b6ea5' },
    })
    renderHook(() => useAccentFromBackground())

    const [base, hover, press, soft] = varsOnRoot()
    expect(base).toMatch(/^hsl\(/)
    expect(hover).toMatch(/^hsl\(/)
    expect(press).toMatch(/^hsl\(/)
    expect(soft).toContain('/ 0.14')
  })

  it('未设置背景时不覆写（回落主题的中性令牌）', () => {
    renderHook(() => useAccentFromBackground())
    expect(varsOnRoot()).toEqual(['', '', '', ''])
  })

  it('背景存在但没取到色时不覆写——不得回落成红色', () => {
    // 透明图 / 无 canvas 环境下 accentFromBlob 返回 null，此时不写 accent 字段
    useSettings.setState({ background: { kind: 'image', mime: 'image/png' } })
    renderHook(() => useAccentFromBackground())
    expect(varsOnRoot()).toEqual(['', '', '', ''])
  })

  it('清除背景后移除覆写，回落当前主题', () => {
    useSettings.setState({
      background: { kind: 'image', mime: 'image/png', accent: '#3b6ea5' },
    })
    const { rerender } = renderHook(() => useAccentFromBackground())
    expect(varsOnRoot()[0]).not.toBe('')

    useSettings.setState({ background: null })
    rerender()
    expect(varsOnRoot()).toEqual(['', '', '', ''])
  })
})
