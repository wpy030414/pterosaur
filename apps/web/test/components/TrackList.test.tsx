import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { TrackList } from '../../src/components/TrackList.js'
import { usePlayer } from '../../src/store/player.js'
import { useLibrary } from '../../src/store/library.js'
import type { Track } from '@pterosaur/shared/types'
import { expandGroups } from '../../src/lib/cassette.js'

// 屏蔽真实展开（会打网络）；各用例按需给 expandGroups 设返回值。
vi.mock('../../src/lib/cassette.js', () => ({
  expandTrack: vi.fn(),
  expandGroups: vi.fn(),
  expandList: vi.fn(),
}))

function track(id: string, title: string, extra: Partial<Track> = {}): Track {
  return {
    source: 'netease',
    id,
    title,
    artist: `艺人${id}`,
    album: `专辑${id}`,
    cover: '',
    duration: 200,
    fee: 'free',
    ...extra,
  }
}

const SONGS = [
  track('1', '第一首'),
  track('2', '第二首', { fee: 'vip' }),
  track('3', '第三首'),
]

/** 显示当前路径，用于断言导航。 */
function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}

/** TrackList 现在依赖路由（行内链接），需包一层 Router。 */
function renderList(ui: ReactElement) {
  return render(
    <MemoryRouter>
      {ui}
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  usePlayer.setState({
    current: null,
    queue: [],
    index: -1,
    baseQueue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    repeat: 'all',
    shuffle: false,
    playError: null,
    expanded: false,
  })
  useLibrary.setState({
    favorites: [],
    recent: [],
    playlists: [],
    savedPlaylists: [],
  })
})

describe('TrackList', () => {
  it('空列表显示占位文案', () => {
    renderList(<TrackList tracks={[]} emptyText="这里空空如也" />)
    expect(screen.getByText('这里空空如也')).toBeInTheDocument()
  })

  it('渲染所有曲目名称与艺人', () => {
    renderList(<TrackList tracks={SONGS} />)
    for (const s of SONGS) {
      expect(screen.getByText(s.title)).toBeInTheDocument()
      expect(screen.getByText(s.artist)).toBeInTheDocument()
    }
  })

  it('VIP 曲目不再显示徽标（歌单内隐藏 VIP chip）', () => {
    renderList(<TrackList tracks={SONGS} />)
    expect(screen.queryByText('VIP')).not.toBeInTheDocument()
  })

  it('时长格式化显示（200s -> 3:20）', () => {
    renderList(<TrackList tracks={[track('1', 'x', { duration: 200 })]} />)
    expect(screen.getByText('3:20')).toBeInTheDocument()
  })

  it('点击行以该列表为队列播放', () => {
    renderList(<TrackList tracks={SONGS} />)
    fireEvent.click(screen.getByText('第二首'))
    const s = usePlayer.getState()
    expect(s.current?.id).toBe('2')
    expect(s.queue).toHaveLength(3)
    expect(s.index).toBe(1)
    expect(s.isPlaying).toBe(true)
  })

  it('点击红心收藏曲目', () => {
    renderList(<TrackList tracks={SONGS} />)
    const hearts = screen.getAllByLabelText('喜欢')
    fireEvent.click(hearts[0])
    expect(useLibrary.getState().favorites).toHaveLength(1)
    expect(useLibrary.getState().favorites[0].id).toBe('1')
  })

  it('已收藏的曲目显示「取消喜欢」并可取消', () => {
    useLibrary.setState({ favorites: [SONGS[0]] })
    renderList(<TrackList tracks={SONGS} />)
    const btn = screen.getByLabelText('取消喜欢')
    fireEvent.click(btn)
    expect(useLibrary.getState().favorites).toHaveLength(0)
  })

  it('当前播放曲目行高亮', () => {
    usePlayer.setState({
      current: SONGS[1],
      queue: SONGS,
      index: 1,
      isPlaying: true,
    })
    const { container } = renderList(<TrackList tracks={SONGS} />)
    const activeRows = container.querySelectorAll('.track-row--current')
    expect(activeRows).toHaveLength(1)
    expect(activeRows[0].textContent).toContain('第二首')
  })

  it('showHeader=false 时不渲染表头', () => {
    const { container } = renderList(
      <TrackList tracks={SONGS} showHeader={false} />,
    )
    expect(container.querySelector('.track-list__head')).toBeNull()
  })

  it('点击当前正在播放的曲目会暂停', () => {
    renderList(<TrackList tracks={SONGS} />)
    fireEvent.click(screen.getByText('第一首'))
    expect(usePlayer.getState().isPlaying).toBe(true)
    fireEvent.click(screen.getByText('第一首'))
    expect(usePlayer.getState().isPlaying).toBe(false)
  })

  it('含 B 站分P 条目时：队列按分P 展开，起点为被点视频的首个分P', async () => {
    const bili = track('BV1', '某合集', { source: 'bilibili' })
    const list = [track('a', '甲'), bili, track('b', '乙')]
    vi.mocked(expandGroups).mockResolvedValueOnce([
      [list[0]],
      [
        track('BV1:1', 'P1 · 甲', { source: 'bilibili' }),
        track('BV1:2', 'P2 · 乙', { source: 'bilibili' }),
      ],
      [list[2]],
    ])
    renderList(<TrackList tracks={list} />)
    fireEvent.click(screen.getByText('某合集'))
    await waitFor(() =>
      expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([
        'a',
        'BV1:1',
        'BV1:2',
        'b',
      ]),
    )
    expect(usePlayer.getState().current?.id).toBe('BV1:1')
  })

  it('点击艺人名跳转艺人页，且不触发行播放', () => {
    const t = [
      track('1', '第一首', {
        artist: '某艺人',
        artistRefs: [{ id: '9', name: '某艺人' }],
      }),
    ]
    renderList(<TrackList tracks={t} />)
    fireEvent.click(screen.getByRole('button', { name: '某艺人' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/artist/netease/9')
    expect(usePlayer.getState().current).toBeNull()
  })

  it('多艺人各自可点击跳转', () => {
    const t = [
      track('1', '合唱', {
        artist: '甲 / 乙',
        artistRefs: [
          { id: '1', name: '甲' },
          { id: '2', name: '乙' },
        ],
      }),
    ]
    renderList(<TrackList tracks={t} />)
    fireEvent.click(screen.getByRole('button', { name: '乙' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/artist/netease/2')
  })

  it('点击专辑名跳转专辑页，且不触发行播放', () => {
    const t = [track('1', '第一首', { album: '某专辑', albumId: '77' })]
    renderList(<TrackList tracks={t} />)
    fireEvent.click(screen.getByRole('button', { name: '某专辑' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/album/netease/77')
    expect(usePlayer.getState().current).toBeNull()
  })

  it('缺少 id 时艺人 / 专辑降级为纯文本（不可点击）', () => {
    const t = [track('1', '第一首')]
    renderList(<TrackList tracks={t} />)
    expect(screen.queryByRole('button', { name: '艺人1' })).toBeNull()
    expect(screen.queryByRole('button', { name: '专辑1' })).toBeNull()
    expect(screen.getByText('艺人1')).toBeInTheDocument()
    expect(screen.getByText('专辑1')).toBeInTheDocument()
  })
})
