import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRouteTransition } from '../../src/lib/viewTransition.js'

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

/** 覆盖 matchMedia（jsdom 未实现）：恒不命中 prefers-reduced-motion。 */
function noReducedMotion(): void {
  window.matchMedia = ((query: string) => ({
    matches: false,
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
  noReducedMotion()
  delete root().dataset.routeDir
  delete root().dataset.routeVt
})

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown })
    .startViewTransition
  delete root().dataset.routeDir
  delete root().dataset.routeVt
})

describe('startRouteTransition', () => {
  it('opts.skip：不跑转场，但仍同步提交更新、不留命名标记', async () => {
    const { spy } = installFakeVT()
    let applied = false

    startRouteTransition(() => (applied = true), 'forward', { skip: true })

    expect(applied).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    // 摘除在下一帧执行（躲开伪树拆除期），等一拍再断言
    await vi.waitFor(() => expect(root().dataset.routeVt).toBeUndefined())
  })

  it('默认（路径变了）：不跑转场，但同步提交更新并写入方向标记', () => {
    const { spy } = installFakeVT()
    let applied = false

    startRouteTransition(() => (applied = true), 'forward')

    // 内容区 View Transition 已停用（播放岛会与 top layer 快照冲突，见 lib/viewTransition.ts）
    expect(spy).not.toHaveBeenCalled()
    expect(applied).toBe(true)
    // 方向标记仍写入——它驱动 app.css 的降级进场动画，与是否支持 VT 无关
    expect(root().dataset.routeDir).toBe('forward')
    // 旧实现的临时命名标记已不再使用
    expect(root().dataset.routeVt).toBeUndefined()
  })

  it('后退：方向标记为 back', () => {
    const { spy } = installFakeVT()

    startRouteTransition(() => {}, 'back')

    expect(spy).not.toHaveBeenCalled()
    expect(root().dataset.routeDir).toBe('back')
  })

  it('skip（同页切换）：不写方向标记，且不残留上一段的方向', () => {
    const { spy } = installFakeVT()

    startRouteTransition(() => {}, 'back')
    expect(root().dataset.routeDir).toBe('back')

    // 随后一次同页变更（如仅改查询串的切 tab）
    startRouteTransition(() => {}, 'forward', { skip: true })

    expect(spy).not.toHaveBeenCalled()
    expect(root().dataset.routeDir).toBeUndefined()
    expect(root().dataset.routeVt).toBeUndefined()
  })

  it('不支持 View Transitions 时直接提交（降级路径）', () => {
    delete (document as unknown as { startViewTransition?: unknown })
      .startViewTransition
    let applied = false
    startRouteTransition(() => (applied = true))
    expect(applied).toBe(true)
  })
})
