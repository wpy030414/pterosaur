import { describe, it, expect, vi } from 'vitest'
import type { LoginStatus, MusicSource } from '@pterosaur/shared/types'
import {
  activeSource,
  activeMusicSource,
  isLoggedAny,
  finishQrLogin,
  useAuth,
} from '../../src/store/auth.js'
import { clearAllAppCaches } from '../../src/lib/clearCaches.js'

vi.mock('../../src/api/client.js', () => ({
  api: { logout: vi.fn().mockResolvedValue({ logged: false }) },
}))
vi.mock('../../src/lib/clearCaches.js', () => ({ clearAllAppCaches: vi.fn() }))

const status = (
  logged: Partial<Record<MusicSource, boolean>>,
): Record<MusicSource, LoginStatus> => ({
  netease: { logged: Boolean(logged.netease) },
  bilibili: { logged: Boolean(logged.bilibili) },
})

describe('activeSource / isLoggedAny（单活动账号，只认音乐源）', () => {
  it('未登录 → null', () => {
    expect(activeSource(status({}))).toBeNull()
    expect(isLoggedAny(status({}))).toBe(false)
  })

  it('登录网易云 → 返回 netease', () => {
    expect(activeSource(status({ netease: true }))).toBe('netease')
    expect(activeMusicSource(status({ netease: true }))).toBe('netease')
    expect(isLoggedAny(status({ netease: true }))).toBe(true)
  })

  it('仅登录 B 站：是「活动账号」（云同步/顶栏跟随），但不是「活动音乐源」', () => {
    expect(activeSource(status({ bilibili: true }))).toBe('bilibili')
    expect(activeMusicSource(status({ bilibili: true }))).toBeNull()
    expect(isLoggedAny(status({ bilibili: true }))).toBe(true)
  })
})

describe('登录 / 退出登录清空全部缓存（见 ADR-034）', () => {
  it('退出登录后清空缓存', async () => {
    await useAuth.getState().logout('netease')
    expect(clearAllAppCaches).toHaveBeenCalled()
  })

  it('扫码登录成功后清空缓存', () => {
    finishQrLogin('netease', { logged: true })
    expect(clearAllAppCaches).toHaveBeenCalled()
  })
})

describe('退出登录保留 loginable（不刷新也能再登录）', () => {
  it('logout 后该源仍标 loginable，不会从登录弹窗的源列表里消失', async () => {
    useAuth.setState({
      status: {
        netease: { logged: true, loginable: true },
        bilibili: { logged: false, loginable: true },
      },
    })
    await useAuth.getState().logout('netease')
    const st = useAuth.getState().status.netease
    expect(st.logged).toBe(false)
    expect(st.loginable).toBe(true)
  })
})
