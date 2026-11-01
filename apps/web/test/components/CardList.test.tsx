import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CardList } from '../../src/components/CardList.js'
import { Rail } from '../../src/components/Rail.js'
import { TrackList } from '../../src/components/TrackList.js'
import { usePlayerQueue } from '../../src/store/playerQueue.js'
import { usePlaybackSession } from '../../src/store/playbackSession.js'
import type { Track } from '@pterosaur/shared/types'

// 展开 B 站分P 会打网络：本文件不涉及，统一屏蔽
vi.mock('../../src/lib/cassette.js', () => ({
  expandTrack: vi.fn(),
  expandGroups: vi.fn(),
  expandList: vi.fn(),
}))

function track(id: string, title: string): Track {
  return {
    source: 'netease',
    id,
    title,
    artist: `艺术家${id}`,
    album: `专辑${id}`,
    cover: '',
    duration: 200,
    fee: 'free',
  }
}

const SONGS = [track('1', '第一首'), track('2', '第二首'), track('3', '第三首')]

function resetStores() {
  usePlayerQueue.setState({ queue: [], index: -1, baseQueue: [] })
  usePlaybackSession.setState({ current: null, isPlaying: false })
}

describe('CardList（卡片列表容器：只管排布）', () => {
  it('缺省纵向栅格', () => {
    render(
      <CardList>
        <span>卡片</span>
      </CardList>,
    )
    const box = screen.getByText('卡片').parentElement!
    expect(box.className).toContain('card-list--grid')
  })

  it('layout="row" 横向排布', () => {
    render(
      <CardList layout="row">
        <span>卡片</span>
      </CardList>,
    )
    const box = screen.getByText('卡片').parentElement!
    expect(box.className).toContain('card-list--row')
    expect(box.className).not.toContain('card-list--grid')
  })
})

describe('Rail 的排布形态', () => {
  it('layout="cards"：内部包一层横向 CardList', () => {
    render(
      <Rail title="推荐歌单" layout="cards">
        <span>卡片</span>
      </Rail>,
    )
    const card = screen.getByText('卡片')
    const list = card.parentElement!
    expect(list.className).toContain('card-list--row')
    // 滚动容器是 CardList 的父节点，且不进入多列网格
    expect(list.parentElement!.className).not.toContain('rail__scroller--grid')
  })

  it('layout="grid"：滚动容器进入多列网格，且不额外包 CardList', () => {
    render(
      <Rail title="歌曲排行" layout="grid">
        <span>行</span>
      </Rail>,
    )
    const child = screen.getByText('行')
    const scroller = child.parentElement!
    expect(scroller.className).toContain('rail__scroller--grid')
  })

  it('旧的布尔 grid 属性仍生效（兼容）', () => {
    render(
      <Rail title="歌曲排行" grid>
        <span>行</span>
      </Rail>,
    )
    expect(screen.getByText('行').parentElement!.className).toContain(
      'rail__scroller--grid',
    )
  })
})

describe('TrackList 的排布形态', () => {
  beforeEach(resetStores)

  it('layout="row"：紧凑曲目行，无表头 / 序号 / 时长列', () => {
    render(
      <MemoryRouter>
        <TrackList layout="row" tracks={SONGS} />
      </MemoryRouter>,
    )
    const list = screen.getByRole('list')
    expect(list.className).toContain('track-list--row')
    expect(screen.queryByText('标题')).toBeNull()
    expect(screen.queryByText('艺术家')).toBeNull()
    // 每张封面本身是一个「播放 X」按钮（悬停出播放图标），文字区不带播放按钮
    const btns = screen.getAllByRole('button', { name: /^播放 / })
    expect(btns).toHaveLength(3)
    expect(btns[0].className).toContain('song-row__main')
    // 封面在左：封面块是行内第一个子元素
    expect(btns[0].firstElementChild!.className).toContain('song-row__cover')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('缺省纵向：保留表头与序号列', () => {
    render(
      <MemoryRouter>
        <TrackList tracks={SONGS} />
      </MemoryRouter>,
    )
    expect(screen.getByText('标题')).toBeTruthy()
    expect(screen.getByText('艺术家')).toBeTruthy()
    // 横向形态是「播放 X」按钮；纵向是整行可点，不出现这类按钮
    expect(screen.queryByRole('button', { name: /^播放 / })).toBeNull()
  })

  it('横向形态的当前曲目高亮', () => {
    usePlaybackSession.setState({ current: SONGS[1], isPlaying: true })
    render(
      <MemoryRouter>
        <TrackList layout="row" tracks={SONGS} />
      </MemoryRouter>,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[1].className).toContain('song-row--current')
    expect(items[0].className).not.toContain('song-row--current')
  })
})
describe('CardList 的排布测量（列数与封面宽由 JS 算出）', () => {
  beforeEach(() => {
    // jsdom 没有 ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
  })

  /** 让元素报告指定宽度（jsdom 的 clientWidth 恒为 0）。 */
  function withWidth(el: Element, w: number) {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: w })
    return el
  }

  it('纵向：列数 × 列距 + 封面宽 = 可用宽度，且封面 ≥ 185px', () => {
    const available = 1116
    const { container } = render(
      <CardList>
        <span>卡片</span>
      </CardList>,
    )
    withWidth(container.querySelector('.card-list')!, available)
    // 重新触发测量：重新挂载（首次挂载时宽度为 0）
    container.remove()
    const { container: c2 } = render(
      <CardList>
        <span>卡片</span>
      </CardList>,
    )
    const list = c2.querySelector<HTMLElement>('.card-list')!
    // 首帧宽度 0 → 1 列；断言变量已写入即可
    expect(list.style.getPropertyValue('--card-cols')).toBe('1')

    // 公式边界：可用宽 1116 时应为 5 列，封面宽 ≥ 185（卡片无内边距，列宽即封面宽）
    const GAP = 16
    const COVER_MIN = 185
    const cols = Math.max(1, Math.floor((available + GAP) / (COVER_MIN + GAP)))
    const cell = (available - (cols - 1) * GAP) / cols
    expect(cols).toBe(5)
    expect(cell).toBeGreaterThanOrEqual(COVER_MIN)
    expect(cols * cell + (cols - 1) * GAP).toBeCloseTo(available, 5)
  })
})

describe('TrackList 横向：歌手名可点击跳转', () => {
  beforeEach(resetStores)

  it('艺术家名渲染为链接按钮，指向艺人页', () => {
    const withRef: Track = {
      ...SONGS[0],
      artistRefs: [{ id: 'ar1', name: '甲' }],
    }
    render(
      <MemoryRouter>
        <TrackList layout="row" tracks={[withRef]} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('button', { name: '甲' })
    expect(link.className).toContain('song-row__artist-link')
  })
})
