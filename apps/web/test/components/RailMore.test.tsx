import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RailMore } from '../../src/components/RailMore.js'

/**
 * `RailMore` 是分区标题行右侧的「更多」文字按钮（传进 `Rail` 的 `action` 槽）。
 *
 * 测试不渲染完整的 Rail：只要组件渲染了一个指向正确地址、配有 aria-label 的链接就算合格。
 */
describe('RailMore（分区标题行「更多」按钮）', () => {
  it('渲染为链接，携带正确的 href 与 aria-label', () => {
    render(
      <MemoryRouter>
        <RailMore to="/search/songs?q=晴天" label="歌曲" />
      </MemoryRouter>,
    )
    const a = screen.getByRole('link', { name: '查看全部歌曲' })
    expect(a).toBeTruthy()
    expect(a.getAttribute('href')).toBe('/search/songs?q=晴天')
    expect(screen.getByText('更多')).toBeTruthy()
  })

  it('磁带与歌单各有自己的 aria-label', () => {
    const { rerender } = render(
      <MemoryRouter>
        <RailMore to="/search/cassette?q=x" label="磁带" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: '查看全部磁带' })).toBeTruthy()

    rerender(
      <MemoryRouter>
        <RailMore to="/search/playlists?q=x" label="歌单" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: '查看全部歌单' })).toBeTruthy()
  })

  it('data-testid 供 E2E 定位', () => {
    render(
      <MemoryRouter>
        <RailMore to="/search/artists?q=x" label="艺人" />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('rail-more')).toBeTruthy()
  })
})
