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
    cookieLogin: vi.fn(),
  },
}))
vi.mock('../../src/lib/clearCaches.js', () => ({ clearAllAppCaches: vi.fn() }))

beforeEach(() => {
  vi.mocked(api.qrCreate).mockClear()
  vi.mocked(api.qrCheck).mockReset()
  vi.mocked(api.qrCheck).mockResolvedValue({ code: 801, logged: false })
  vi.mocked(api.cookieLogin).mockReset()
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

describe('LoginModal 登录方式', () => {
  it('只面向网易云：无源 tab，默认走扫码', async () => {
    render(<LoginModal />)
    expect(screen.getByRole('heading', { name: '登录网易云音乐' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '哔哩哔哩' })).toBeNull()
    await waitFor(() => expect(api.qrCreate).toHaveBeenCalledWith('netease'))
  })

  it('扫码撞 8821 风控时停止轮询并引导改用粘贴 cookie', async () => {
    vi.mocked(api.qrCheck).mockResolvedValue({
      code: 8821,
      logged: false,
      message: '请切换其他登录方式或升级新版本再试',
    })
    render(<LoginModal />)
    await waitFor(
      () => expect(screen.getByRole('alert').textContent).toContain('风控'),
      { timeout: 3000 },
    )
    const calls = vi.mocked(api.qrCheck).mock.calls.length
    // 已停止轮询：等过一个周期也不再有新的 check
    await new Promise((r) => setTimeout(r, 1500))
    expect(vi.mocked(api.qrCheck).mock.calls.length).toBe(calls)
  })

  it('粘贴 cookie 登录成功后写入登录态并关闭弹窗', async () => {
    vi.mocked(api.cookieLogin).mockResolvedValue({
      logged: true,
      nickname: 'tester',
      userId: '42',
    })
    render(<LoginModal />)

    fireEvent.click(screen.getByRole('tab', { name: '自提供 Cookie' }))
    fireEvent.change(screen.getByLabelText('网易云 cookie'), {
      target: { value: '00DE8longvalue' },
    })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() =>
      expect(api.cookieLogin).toHaveBeenCalledWith('netease', '00DE8longvalue'),
    )
    await waitFor(() =>
      expect(useAuth.getState().status.netease.logged).toBe(true),
    )
    expect(useAuth.getState().modalOpen).toBe(false)
    expect(useAuth.getState().status.netease.userId).toBe('42')
  })
})
