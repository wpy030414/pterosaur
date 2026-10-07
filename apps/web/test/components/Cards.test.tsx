import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PlaylistCard } from '../../src/components/PlaylistCard.js'
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
