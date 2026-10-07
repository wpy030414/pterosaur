import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startNowPlayingTransition } from '../../src/lib/nowPlayingTransition.js'
import { usePlayer } from '../../src/store/player.js'

/**
 * mock 出 View Transitions 的最小行为：捕获回调并异步执行（模拟 UA 拍完旧快照后更新）。
 * `finished` 在回调完成后 resolve；`skipTransition()` 立即 resolve（模拟被跳过）。
 */
interface FakeVT {
  finished: Promise<void>
  skipTransition: ReturnType<typeof vi.fn>
}

function installFakeVT(): { spy: ReturnType<typeof vi.fn>; list: FakeVT[] } {
  const list: FakeVT[] = []
  const spy = vi.fn((cb: () => void | Promise<void>) => {
    let settle!: () => void
    const finished = new Promise<void>((r) => (settle = r))
    const vt: FakeVT = { finished, skipTransition: vi.fn(settle) }
    list.push(vt)
    // 模拟 UA：回调在旧快照拍摄后异步执行，完成后 finished settle
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
  usePlayer.setState({ expanded: false })
  delete root().dataset.npVt
  setReducedMotion(false)
})

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown })
    .startViewTransition
  delete root().dataset.npVt
  setReducedMotion(false)
})

describe('startNowPlayingTransition', () => {
  it('不支持 View Transitions 时直接切换、不设 data-np-vt', () => {
    delete (document as unknown as { startViewTransition?: unknown })
      .startViewTransition
    startNowPlayingTransition(true)
    expect(usePlayer.getState().expanded).toBe(true)
    expect(root().dataset.npVt).toBeUndefined()
  })

  it('偏好减少动效时跳过转场、直接切换', () => {
    const { spy } = installFakeVT()
    setReducedMotion(true)

    startNowPlayingTransition(true)

    expect(usePlayer.getState().expanded).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect(root().dataset.npVt).toBeUndefined()
  })

  it('支持时：同步打标 data-np-vt，回调内翻转状态，结束后清除标记', async () => {
    const { spy } = installFakeVT()

    startNowPlayingTransition(true)

    // 标记必须在 startViewTransition 之前就绪（拍旧快照时 CSS 需已摘 .app-content 的命名）
    expect(root().dataset.npVt).toBe('open')
    expect(spy).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(usePlayer.getState().expanded).toBe(true))
    await vi.waitFor(() => expect(root().dataset.npVt).toBeUndefined())
  })

  it('收起走同一路径：标记为 close', () => {
    installFakeVT()
    usePlayer.setState({ expanded: true })
    startNowPlayingTransition(false)
    expect(root().dataset.npVt).toBe('close')
  })

  it('连点：第二次调用先 skip 掉上一段未完成的转场', async () => {
    const { list } = installFakeVT()

    startNowPlayingTransition(true)
    startNowPlayingTransition(false)

    expect(list).toHaveLength(2)
    expect(list[0].skipTransition).toHaveBeenCalledOnce()
    // 被 skip 的旧转场结束后不清除标记（标记归新转场所有）
    await vi.waitFor(() => expect(usePlayer.getState().expanded).toBe(false))
    await vi.waitFor(() => expect(root().dataset.npVt).toBeUndefined())
  })
})
