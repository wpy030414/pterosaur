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

  it('封面直接以 16:9 视频比例展示，不套外壳（ADR-044）', () => {
    const { container } = render(
      <CassetteCard cassette={cassette(3)} onClick={() => {}} />,
    )
    const art = container.querySelector('.card__art--cassette') as Element
    expect(art).toBeTruthy()
    // 16:9 是封面位自身的比例；封面与播放按钮直接挂在它下面，中间不再有磁带外壳
    expect(art.children).toHaveLength(2)
    expect(art.querySelector('.card__cover')).toBeTruthy()
    expect(art.querySelector('.card__play')).toBeTruthy()
    expect(container.querySelector('[class*=cassette-shell]')).toBeNull()
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
