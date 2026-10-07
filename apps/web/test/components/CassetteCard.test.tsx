import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Playlist } from '@pterosaur/shared/types'

const { playPlaylist } = vi.hoisted(() => ({ playPlaylist: vi.fn() }))

// 屏蔽真实集合播放（会打网络）；只关心卡片的触发与参数
vi.mock('../../src/hooks/usePlayCollection.js', () => ({
  usePlayCollection: () => ({ playPlaylist, playAlbum: vi.fn() }),
}))

import { CassetteCard } from '../../src/components/CassetteCard.js'

const cassette = (trackCount?: number): Playlist => ({
  source: 'bilibili',
  id: 'BV1',
  name: '磁带',
  cover: '',
  creator: 'UP 主',
  trackCount,
})

const playBtn = () => screen.getByRole('button', { name: '播放' })

describe('CassetteCard', () => {
  beforeEach(() => {
    playPlaylist.mockClear()
  })

  it('以磁带外壳 + 4:3 视频窗 + 卷轴带渲染（磁带象征）', () => {
    const { container } = render(
      <CassetteCard cassette={cassette(3)} onClick={() => {}} />,
    )
    expect(container.querySelector('.card--cassette')).toBeTruthy()
    expect(container.querySelector('.card__art--cassette')).toBeTruthy()
    expect(container.querySelector('.cassette-shell__window')).toBeTruthy()
    // 磁带象征：卷轴带 + 两枚卷轴 + 两者间的一段磁带
    expect(container.querySelector('.cassette-shell__deck')).toBeTruthy()
    expect(container.querySelector('.cassette-shell__tape')).toBeTruthy()
    expect(container.querySelectorAll('.cassette-reel')).toHaveLength(2)
  })

  it('数量 chip：> 1 才显示（分P 数）', () => {
    const { rerender } = render(
      <CassetteCard cassette={cassette(3)} onClick={() => {}} />,
    )
    expect(screen.getByText('3 首')).toBeInTheDocument()
    rerender(<CassetteCard cassette={cassette(1)} onClick={() => {}} />)
    expect(screen.queryByText('1 首')).toBeNull()
  })

  it('空磁带（trackCount=0）：播放按钮置灰', () => {
    render(<CassetteCard cassette={cassette(0)} onClick={() => {}} />)
    expect(playBtn()).toBeDisabled()
  })

  it('点播放按钮：整盘播放（不进入详情页）', () => {
    const onClick = vi.fn()
    render(<CassetteCard cassette={cassette(3)} onClick={onClick} />)
    fireEvent.click(playBtn())
    expect(playPlaylist).toHaveBeenCalledWith('bilibili', 'BV1')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('点卡片本体：进入详情页（选分P）', () => {
    const onClick = vi.fn()
    const { container } = render(
      <CassetteCard cassette={cassette(3)} onClick={onClick} />,
    )
    fireEvent.click(container.querySelector('.card--cassette') as Element)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(playPlaylist).not.toHaveBeenCalled()
  })
})
