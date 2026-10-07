import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Cover } from '../../src/components/Cover.js'
import { clearCoverRegistry } from '../../src/lib/imageCache.js'

// jsdom 不会真正加载图片，这里直接桩掉 complete / naturalWidth 以覆盖「已缓存」与「加载失败」分支
const origComplete = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  'complete',
)
const origNaturalWidth = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  'naturalWidth',
)

function stubImage(complete: boolean, naturalWidth: number) {
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get: () => complete,
  })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => naturalWidth,
  })
}

afterEach(() => {
  if (origComplete)
    Object.defineProperty(HTMLImageElement.prototype, 'complete', origComplete)
  if (origNaturalWidth)
    Object.defineProperty(
      HTMLImageElement.prototype,
      'naturalWidth',
      origNaturalWidth,
    )
})

// 就绪登记表是模块级状态，逐例清空避免相互影响
beforeEach(() => clearCoverRegistry())

describe('Cover 预载防闪', () => {
  it('已缓存的图片挂载即显色（complete 且 naturalWidth>0）', () => {
    stubImage(true, 300)
    const { container } = render(<Cover src="/x.jpg" alt="x" />)
    expect(container.querySelector('.cover')).toHaveClass('cover--loaded')
  })

  it('complete 但加载失败（naturalWidth=0）回退占位', () => {
    stubImage(true, 0)
    const { container } = render(<Cover src="/x.jpg" alt="x" />)
    expect(container.querySelector('.cover__fallback')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('加载未完成时保持占位（不加 loaded）', () => {
    stubImage(false, 0)
    const { container } = render(<Cover src="/x.jpg" alt="x" />)
    expect(container.querySelector('.cover')).not.toHaveClass('cover--loaded')
  })
})
