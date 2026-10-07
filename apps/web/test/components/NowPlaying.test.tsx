import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NowPlaying } from '../../src/components/NowPlaying.js'
import { usePlayer } from '../../src/store/player.js'
import { clearCoverRegistry } from '../../src/lib/imageCache.js'
import { clearLyricCache } from '../../src/lib/lyricCache.js'
import type { Track } from '@pterosaur/shared/types'

// 沉浸页会拉歌词：mock 掉 api 客户端，避免真实 fetch
vi.mock('../../src/api/client.js', () => ({
  api: { lyric: vi.fn().mockResolvedValue({ lines: [], timed: false }) },
}))

/**
 * 可控假 Image（jsdom 不真正加载图片）：构造即登记，测试手动触发 onload/onerror，
 * 模拟「封面已缓存（立即就绪）/ 网络延迟（挂起）/ 加载失败」三种时序。
 */
const created: Array<{
  src: string
  onload: (() => void) | null
  onerror: (() => void) | null
  decode: () => Promise<void>
}> = []

class FakeImage {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  decode = () => Promise.resolve()
  constructor() {
    created.push(this as unknown as (typeof created)[number])
  }
}

function track(id: string, cover: string): Track {
  return {
    source: 'netease',
    id,
    title: `歌曲${id}`,
    artist: `艺人${id}`,
    album: `专辑${id}`,
    cover,
    duration: 200,
    fee: 'free',
  }
}

const A = track('1', '/a.jpg')
const B = track('2', '/b.jpg')
const C = track('3', '/c.jpg')

function bgLayers(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('.nowplaying__bg'))
}

function bgUrls(container: HTMLElement) {
  // jsdom 会把 url(...) 序列化为带引号的形式，这里统一去掉引号再比较
  return bgLayers(container).map((el) =>
    el.style.backgroundImage.replace(/["']/g, ''),
  )
}

function lastImage() {
  return created[created.length - 1]
}

/** 设置当前曲目并冲刷 effect / 微任务。 */
async function play(t: Track) {
  await act(async () => {
    usePlayer.setState({ current: t, index: 0, queue: [t], baseQueue: [t] })
  })
}

/** 冲刷微任务队列：onload → decode → settle → setBg 跨了多个微任务 tick。 */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 触发最近一次封面加载成功（再冲刷微任务，让 whenCoverReady 落定并更新背景层）。 */
async function coverArrives() {
  await act(async () => {
    lastImage().onload!()
    await flushMicrotasks()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  created.length = 0
  clearCoverRegistry()
  clearLyricCache()
  usePlayer.setState({
    current: null,
    queue: [],
    index: -1,
    baseQueue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
  })
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('NowPlaying 切歌背景防闪', () => {
  it('首曲封面就绪后直接落位为单层背景', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    expect(bgUrls(container)).toEqual(['url(/a.jpg)'])
  })

  it('切歌后新封面未就绪期间，背景层保持旧封面（核心回归）', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    expect(bgUrls(container)).toEqual(['url(/a.jpg)'])

    // 切到 B，但封面仍在「下载中」（不触发 onload）：背景绝不能变成 B 或空白
    await play(B)
    expect(bgUrls(container)).toEqual(['url(/a.jpg)'])
    expect(container.querySelectorAll('.nowplaying__bg')).toHaveLength(1)
  })

  it('新封面就绪后以淡入层盖上，旧封面垫底；淡完落位收敛回单层', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    await play(B)
    await coverArrives()

    // 交叉淡入期间：两层，A 垫底、B 带淡入动画类盖其上
    const layers = bgLayers(container)
    expect(bgUrls(container)).toEqual(['url(/a.jpg)', 'url(/b.jpg)'])
    expect(layers[1]).toHaveClass('nowplaying__bg-in')

    // 淡入动画（--dur-slow=400ms）+ 落位余量之后：收敛回单层 B
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(bgUrls(container)).toEqual(['url(/b.jpg)'])
  })

  it('新封面加载失败 → 维持旧背景，不出现空白层', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    await play(B)
    await act(async () => {
      lastImage().onerror!()
      await flushMicrotasks()
    })
    expect(bgUrls(container)).toEqual(['url(/a.jpg)'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(bgUrls(container)).toEqual(['url(/a.jpg)'])
  })

  it('快速连切 A→B→C（B 未就绪即被切走）：直接淡入 C，B 不再出现', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    await play(B) // B 封面挂起
    await play(C) // 立刻切走
    await coverArrives() // C 就绪

    expect(bgUrls(container)).toEqual(['url(/a.jpg)', 'url(/c.jpg)'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(bgUrls(container)).toEqual(['url(/c.jpg)'])
  })

  it('同一封面重复触发（StrictMode 双跑等）不重复淡入', async () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlaying open exiting={false} />
      </MemoryRouter>,
    )
    await play(A)
    await coverArrives()
    // B 落位后再次把 current 设回同一对象引用变化但封面相同的情况
    await play(B)
    await coverArrives()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    // current 仍为 B（对象引用相同）→ 无任何变化
    await play(B)
    await coverArrives() // whenCoverReady 立即 true，但已在 stable 上，无新层
    expect(bgUrls(container)).toEqual(['url(/b.jpg)'])
  })
})
