import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
vi.mock('../../src/hooks/usePlayCollection.js', () => ({
  usePlayCollection: () => ({ playPlaylist: vi.fn(), playAlbum: vi.fn() }),
}))
import { PlaylistCard } from '../../src/components/PlaylistCard.js'
import { CassetteCard } from '../../src/components/CassetteCard.js'
import { AlbumCard } from '../../src/components/EntityCards.js'
import type { Album, Playlist } from '@pterosaur/shared/types'

const playlist = (trackCount?: number): Playlist => ({
  source: 'netease',
  id: 'p1',
  name: '歌单',
  cover: '',
  trackCount,
})
const album = (trackCount?: number): Album => ({
  source: 'netease',
  id: 'a1',
  name: '专辑',
  cover: '',
  artist: '甲',
  trackCount,
})

/** 播放按钮（aria-label 恰为「播放」；Testing Library 的 name 默认精确匹配）。 */
const playBtn = () => screen.getByRole('button', { name: '播放' })

describe('卡片播放按钮的可用性', () => {
  it('空白歌单：播放按钮置灰（禁用）', () => {
    render(<PlaylistCard playlist={playlist(0)} onClick={() => {}} />)
    expect(playBtn()).toBeDisabled()
  })

  it('非空歌单：播放按钮可用', () => {
    render(<PlaylistCard playlist={playlist(5)} onClick={() => {}} />)
    expect(playBtn()).toBeEnabled()
  })

  it('曲目数未知（undefined）时不置灰', () => {
    render(<PlaylistCard playlist={playlist(undefined)} onClick={() => {}} />)
    expect(playBtn()).toBeEnabled()
  })

  it('空白专辑：播放按钮置灰（禁用）', () => {
    render(<AlbumCard album={album(0)} onClick={() => {}} />)
    expect(playBtn()).toBeDisabled()
  })

  it('非空专辑：播放按钮可用', () => {
    render(<AlbumCard album={album(3)} onClick={() => {}} />)
    expect(playBtn()).toBeEnabled()
  })
})

describe('封面右上角不再显示曲目数量（改用光波封面）', () => {
  it('多首歌单也不渲染数量文案', () => {
    render(<PlaylistCard playlist={playlist(7)} onClick={() => {}} />)
    expect(screen.queryByText('7 首')).toBeNull()
  })

  it('unknown 数量不渲染任何「首」字样', () => {
    render(<PlaylistCard playlist={playlist(undefined)} onClick={() => {}} />)
    expect(screen.queryByText(/首/)).toBeNull()
  })
})

describe('预览卡不显示副标题（播放量 / 简介 / 创建者）', () => {
  it('歌单卡：即便带描述与创建者，也只渲染标题', () => {
    const { container } = render(
      <PlaylistCard
        playlist={{
          ...playlist(5),
          description: '一段歌单简介',
          creator: '某用户',
          playCount: 123456,
        }}
        onClick={() => {}}
      />,
    )
    expect(container.querySelector('.card__subtitle')).toBeNull()
    expect(screen.queryByText(/次播放/)).toBeNull()
    expect(screen.queryByText('一段歌单简介')).toBeNull()
    expect(screen.queryByText('by 某用户')).toBeNull()
  })

  it('磁带卡：不渲染 UP 主', () => {
    const { container } = render(
      <CassetteCard
        cassette={{
          source: 'bilibili',
          id: 'BV1',
          name: '磁带',
          cover: '',
          creator: 'UP 主',
          trackCount: 3,
        }}
        onClick={() => {}}
      />,
    )
    expect(container.querySelector('.card__subtitle')).toBeNull()
    expect(screen.queryByText('by UP 主')).toBeNull()
  })
})
