import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startThemeTransition } from '../../src/lib/themeTransition.js'

/**
 * mock View Transitions 的最小行为：捕获回调并异步执行；`finished` 在回调完成后 resolve；
 * `skipTransition()` 立即 resolve（模拟被跳过）。
 */
interface FakeVT {
  finished: Promise<void>
  skipTransition: ReturnType<typeof vi.fn>
}

function installFakeVT(): { spy: ReturnType<typeof vi.fn>; list: FakeVT[] } {
  const list: FakeVT[] = []
  const spy = vi.fn((cb: () => void) => {
    let settle!: () => void
    const finished = new Promise<void>((r) => (settle = r))
    const vt: FakeVT = { finished, skipTransition: vi.fn(settle) }
    list.push(vt)
    void Promise.resolve()
      .then(cb)
      .then(() => settle())
    return vt
  })
  ;(
    document as unknown as { startViewTransition: unknown }
  ).startViewTransition = spy
  return { spy, list }
}

const root = () => document.documentElement

/** 覆盖 matchMedia（jsdom 未实现）：`reduce` 决定 prefers-reduced-motion 是否命中。 */
function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  delete root().dataset.themeVt
  setReducedMotion(false)
})

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown })
    .startViewTransition
  delete root().dataset.themeVt
  setReducedMotion(false)
})

describe('startThemeTransition', () => {
  it('不支持 View Transitions 时直接切换、不设 data-theme-vt', () => {
    delete (document as unknown as { startViewTransition?: unknown })
      .startViewTransition
    let applied = false
    startThemeTransition({ x: 0, y: 0 }, () => {
      applied = true
    })
    expect(applied).toBe(true)
    expect(root().dataset.themeVt).toBeUndefined()
  })

  it('偏好减少动效时跳过转场、直接切换', () => {
    const { spy } = installFakeVT()
    setReducedMotion(true)
    let applied = false
    startThemeTransition({ x: 0, y: 0 }, () => {
      applied = true
    })
    expect(applied).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('支持时：同步打标与注入圆心/半径，回调内切换，结束后清除标记', async () => {
    const { spy } = installFakeVT()

    let applied = false
    startThemeTransition({ x: 100, y: 50 }, () => {
      applied = true
    })

    // 标记与圆心/半径必须在 startViewTransition 之前就绪（拍旧快照时 CSS 需已读到）
    expect(root().dataset.themeVt).toBe('on')
    expect(root().style.getPropertyValue('--theme-vt-x')).toBe('100px')
    expect(root().style.getPropertyValue('--theme-vt-y')).toBe('50px')
    expect(root().style.getPropertyValue('--theme-vt-r')).not.toBe('')
    expect(spy).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(applied).toBe(true))
    await vi.waitFor(() => expect(root().dataset.themeVt).toBeUndefined())
  })

  it('连点：第二次调用先 skip 掉上一段未完成的转场', () => {
    const { list } = installFakeVT()

    startThemeTransition({ x: 0, y: 0 }, () => {})
    startThemeTransition({ x: 0, y: 0 }, () => {})

    expect(list).toHaveLength(2)
    expect(list[0].skipTransition).toHaveBeenCalledOnce()
  })
})
