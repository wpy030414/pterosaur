import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoginModal } from '../../src/components/LoginModal.js'
import { useAuth } from '../../src/store/auth.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({
  api: {
    qrCreate: vi
      .fn()
      .mockResolvedValue({ key: 'k', qrimg: 'data:image/png;base64,AAA' }),
    qrCheck: vi.fn().mockResolvedValue({ code: 801, logged: false }),
  },
}))
vi.mock('../../src/lib/clearCaches.js', () => ({ clearAllAppCaches: vi.fn() }))

beforeEach(() => {
  vi.mocked(api.qrCreate).mockClear()
  useAuth.setState({
    modalOpen: true,
    modalSource: 'netease',
    error: null,
    status: {
      netease: { logged: false, loginable: true },
      bilibili: { logged: false, loginable: true },
    },
    loaded: { netease: true, bilibili: true },
  })
})

describe('LoginModal 源 tab', () => {
  it('可切到「哔哩哔哩」并保持选中，不被弹回网易云（回归护栏）', async () => {
    render(<LoginModal />)

    const netease = screen.getByRole('tab', { name: '网易云音乐' })
    const bilibili = screen.getByRole('tab', { name: '哔哩哔哩' })
    expect(netease).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(bilibili)

    // 切过去后必须**留在** B 站（此前每次渲染都被 effect 顶回 modalSource）
    await waitFor(() =>
      expect(bilibili).toHaveAttribute('aria-selected', 'true'),
    )
    expect(netease).toHaveAttribute('aria-selected', 'false')
    // 二维码也应为 B 站重新生成
    await waitFor(() =>
      expect(api.qrCreate).toHaveBeenLastCalledWith('bilibili'),
    )
  })
})
