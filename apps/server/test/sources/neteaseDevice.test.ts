import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 设备身份提供者的单测：不真起浏览器——把 playwright-core 换成可编程的 fake，
 * 只验证取身份的编排逻辑（白名单过滤、缓存 TTL、并发去重、超时与降级）。
 * 真 headless 链路由「手动验收：pnpm log-in 扫码」覆盖（见 ADR-052）。
 */
const pw = vi.hoisted(() => {
  const state: {
    launches: number
    channels: (string | undefined)[]
    launchError: string | null
    token: string
    cookies: { name: string; value: string }[]
    hang: boolean
    resolves: (() => void) | null
  } = {
    launches: 0,
    channels: [],
    launchError: null,
    token: '',
    cookies: [],
    hang: false,
    resolves: null,
  }
  return state
})

vi.mock('playwright-core', () => {
  const page = {
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async () => {
      if (pw.hang) return new Promise<void>((r) => (pw.resolves = r))
      return pw.token
    },
    close: async () => {},
  }
  const ctx = {
    newPage: async () => page,
    cookies: async () => pw.cookies,
    close: async () => {},
  }
  return {
    chromium: {
      launch: async (opts: { channel?: string }) => {
        pw.launches++
        pw.channels.push(opts?.channel)
        if (pw.launchError) throw new Error(pw.launchError)
        return { newContext: async () => ctx, close: async () => {} }
      },
    },
  }
})

/** 每个用例拿一份干净的模块实例（cached/inflight 是模块级单例）。 */
async function freshModule() {
  vi.resetModules()
  return import('../../src/sources/neteaseDevice.js')
}

beforeEach(() => {
  pw.launches = 0
  pw.channels = []
  pw.launchError = null
  pw.token = ''
  pw.cookies = []
  pw.hang = false
  pw.resolves = null
  vi.useRealTimers()
})

describe('neteaseDevice 设备身份', () => {
  it('成功路径：取 token、按白名单滤 cookie、提取 sDeviceId', async () => {
    pw.token = 'tok-32-chars-aaaaaaaaaaaaaaaaa'
    pw.cookies = [
      { name: 'WM_TID', value: 'tid1' },
      { name: 'WM_NIKE', value: 'nik1' },
      { name: 'Hm_lvt_123', value: 'baidu-stat' },
      { name: 'sDeviceId', value: 'YD-real' },
      { name: 'NMTID', value: 'nm1' },
    ]
    const m = await freshModule()
    const identity = await m.ensureNeteaseDeviceIdentity(2000)
    expect(identity.token).toBe('tok-32-chars-aaaaaaaaaaaaaaaaa')
    expect(identity.sDeviceId).toBe('YD-real')
    // 白名单内的按序拼接，百度统计被滤掉
    expect(identity.cookieHeader).toBe(
      'WM_TID=tid1; WM_NIKE=nik1; sDeviceId=YD-real; NMTID=nm1',
    )
    // 优先走系统 Edge 通道
    expect(pw.channels[0]).toBe('msedge')
  })

  it('token 拿不到时（页面就绪但 SDK 未返回）视为该通道失败，继续尝试下一通道', async () => {
    pw.token = '' // evaluate 返回空串 → tryWithChannel 返回 null → 换通道
    const m = await freshModule()
    const identity = await m.ensureNeteaseDeviceIdentity(500)
    expect(identity.token).toBe('')
    expect(pw.channels).toEqual(['msedge', 'chrome', undefined])
  })

  it('所有浏览器通道都启动失败时降级为空身份，并进入 60s 负缓存', async () => {
    pw.launchError = 'no browser'
    const m = await freshModule()
    const identity = await m.ensureNeteaseDeviceIdentity(500)
    expect(identity.token).toBe('')
    expect(identity.cookieHeader).toBe('')
    expect(m.getCachedNeteaseDeviceIdentity()).toEqual({
      token: '',
      cookieHeader: '',
    })

    // 负缓存期内 refresh 直接跳过（不重试起浏览器）
    pw.launchError = null
    pw.token = 'later-token'
    const before = pw.launches
    m.refreshNeteaseDeviceIdentity()
    expect(pw.launches).toBe(before)

    // 60s 过后即可重取
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    const again = await m.ensureNeteaseDeviceIdentity(500)
    expect(again.token).toBe('later-token')
  })

  it('成功身份缓存 20h；过期后重取', async () => {
    pw.token = 'fresh'
    pw.cookies = [{ name: 'WM_TID', value: 't' }]
    const m = await freshModule()
    await m.ensureNeteaseDeviceIdentity(500)
    expect(m.getCachedNeteaseDeviceIdentity()?.token).toBe('fresh')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 19 * 60 * 60 * 1000)
    expect(m.getCachedNeteaseDeviceIdentity()?.token).toBe('fresh')

    pw.token = 'renewed'
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000) // 累计 21h > 20h
    const again = await m.ensureNeteaseDeviceIdentity(500)
    expect(again.token).toBe('renewed')
    expect(pw.launches).toBe(2)
  })

  it('并发刷新共享同一个 inflight，只起一次浏览器', async () => {
    pw.token = 'tok'
    pw.cookies = [{ name: 'WM_TID', value: 't' }]
    const m = await freshModule()
    await Promise.all([
      m.ensureNeteaseDeviceIdentity(500),
      m.ensureNeteaseDeviceIdentity(500),
      m.ensureNeteaseDeviceIdentity(500),
    ])
    expect(pw.launches).toBe(1)
  })

  it('headless 卡住时 ensure 按超时降级，不阻塞调用方；后台完成后缓存可用', async () => {
    pw.hang = true
    const m = await freshModule()
    const t0 = Date.now()
    const identity = await m.ensureNeteaseDeviceIdentity(150)
    expect(identity.token).toBe('')
    expect(Date.now() - t0).toBeLessThan(1000)

    // 后台 inflight 完成（解除挂起）后，缓存就绪
    pw.token = 'slow-but-ok'
    pw.hang = false
    pw.resolves?.()
    await new Promise((r) => setTimeout(r, 10))
    expect(m.getCachedNeteaseDeviceIdentity()?.token).toBe('slow-but-ok')
  })

  it('invalidate 后下一次 refresh 重新起浏览器', async () => {
    pw.token = 'v1'
    const m = await freshModule()
    await m.ensureNeteaseDeviceIdentity(500)
    m.invalidateNeteaseDeviceIdentity()
    expect(m.getCachedNeteaseDeviceIdentity()).toBeNull()

    pw.token = 'v2'
    const again = await m.ensureNeteaseDeviceIdentity(500)
    expect(again.token).toBe('v2')
    expect(pw.launches).toBe(2)
  })

  it('headless 失败后 60s 内 refresh 节流（8821 自愈高频触发也不空跑浏览器）', async () => {
    pw.launchError = 'no browser'
    const m = await freshModule()
    await m.ensureNeteaseDeviceIdentity(500) // 失败 → 记 lastFailureAt
    expect(pw.launches).toBe(3) // msedge → chrome → 默认，各试一次

    // 模拟 8821 自愈：invalidate（清缓存）+ 连续多次 refresh
    m.invalidateNeteaseDeviceIdentity()
    pw.launchError = null
    pw.token = 'recovered'
    m.refreshNeteaseDeviceIdentity()
    m.refreshNeteaseDeviceIdentity()
    m.refreshNeteaseDeviceIdentity()
    await m.ensureNeteaseDeviceIdentity(200)
    // 节流期内一次浏览器都不起，且 ensure 直接拿降级身份
    expect(pw.launches).toBe(3)
    expect(m.getCachedNeteaseDeviceIdentity()).toBeNull() // 被 invalidate 清过、未刷新

    // 61s 后节流解除，可重取
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    const again = await m.ensureNeteaseDeviceIdentity(500)
    expect(again.token).toBe('recovered')
    expect(pw.launches).toBeGreaterThan(3)
  })
})
