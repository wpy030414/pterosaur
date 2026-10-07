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
  delete root().dataset.routeVt
  delete root().dataset.routeDir
})

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown })
    .startViewTransition
  delete root().dataset.routeVt
  delete root().dataset.routeDir
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

  it('默认（路径变了）：跑转场，且命名标记在拍旧快照之前就绪', async () => {
    const { spy } = installFakeVT()
    let applied = false

    startRouteTransition(() => (applied = true), 'forward')

    // 标记必须先于 startViewTransition 就绪（拍旧快照时 CSS 需已命名内容区）
    expect(root().dataset.routeVt).toBe('on')
    expect(spy).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(applied).toBe(true))
    await vi.waitFor(() => expect(root().dataset.routeVt).toBeUndefined())
  })

  it('连续切换：开新转场前先 skip 掉上一段在飞转场（防旧快照层滞留）', () => {
    const { list } = installFakeVT()

    startRouteTransition(() => {}, 'forward')
    startRouteTransition(() => {}, 'forward')

    expect(list).toHaveLength(2)
    expect(list[0].skipTransition).toHaveBeenCalledOnce()
  })

  it('skip 更新也会掐掉在飞转场（转场中切 tab：旧快照不得盖住新内容）', () => {
    const { list } = installFakeVT()

    // 先起一段路由转场（如下钻返回），未结束就来一次同页切 tab
    startRouteTransition(() => {}, 'back')
    startRouteTransition(() => {}, 'forward', { skip: true })

    expect(list).toHaveLength(1)
    expect(list[0].skipTransition).toHaveBeenCalledOnce()
    // 不转场路径不再命名内容区
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
