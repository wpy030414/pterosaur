import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { createApp, audioContentTypeFromUrl } from '../src/app.js'
import {
  BILIBILI_SESSION_COOKIE_NAMES,
  bilibiliAdapter,
} from '../src/sources/bilibili.js'
import { neteaseAdapter } from '../src/sources/netease.js'

const app = createApp()

/**
 * 直接对适配器方法做 spy。适配器是模块级单例对象，`app` 经 `adapterOf` 取到同一对象，
 * 故替换其方法即可拦截上游调用（比 `vi.mock` 模块更稳，且不受「适配器对象在模块求值时
 * 就捕获了真实函数」的影响）。vitest 配置 `restoreMocks: true` 会在每个用例后自动还原。
 */
let qrCheckMock: Mock
let loginStatusMock: Mock
let searchSongsMock: Mock

beforeEach(() => {
  qrCheckMock = vi.spyOn(neteaseAdapter, 'qrCheck')
  loginStatusMock = vi.spyOn(neteaseAdapter, 'loginStatus')
  searchSongsMock = vi.spyOn(neteaseAdapter, 'searchSongs')
})

/** 复刻网易云 803 响应的真实形态：一条超长 MUSIC_U + 数十条 clientlog/feedback 类无关 cookie。 */
function loginCookies() {
  const cookies = [
    `MUSIC_U=${'A'.repeat(380)}; Max-Age=15552000; Expires=Wed, 31 Mar 2027 17:41:51 GMT; Path=/;`,
    '__csrf=504f94f752ea5436e36b39b00a974e0a; Max-Age=1296010; Expires=Sat, 17 Oct 2026 17:42:01 GMT; Path=/;',
    'NMTID=00Om2x4LRy61UHuRUpfvZ6ky4cQ6XcAAAGg_bVIbg; Max-Age=315360000; Expires=Mon, 29 Sep 2036 17:41:51 GMT; Path=/;',
    'MUSIC_A=0f1179cb01aa44f29c48f90b78b0485f9bd2b6f6a44e1f2a; Max-Age=315360000; Expires=Mon, 29 Sep 2036 17:41:51 GMT; Path=/;',
    'MUSIC_SNS=; Max-Age=0; Expires=Fri, 02 Oct 2026 17:41:51 GMT; Path=/;',
  ]
  const scopes = [
    'eapi/clientlog',
    'api/clientlog',
    'openapi/clientlog',
    'wapi/clientlog',
    'weapi/clientlog',
    'neapi/clientlog',
    'api/feedback',
    'eapi/feedback',
    'openapi/feedback',
    'wapi/feedback',
    'weapi/feedback',
  ]
  for (const scope of scopes) {
    cookies.push(
      `MUSIC_A_T=1477146889814; Max-Age=2147483647; Expires=Wed, 20 Oct 2094 20:55:58 GMT; Path=/${scope};`,
      `MUSIC_R_T=1477146960737; Max-Age=2147483647; Expires=Wed, 20 Oct 2094 20:55:58 GMT; Path=/${scope};`,
    )
  }
  for (const scope of ['api/login/token/refresh', 'eapi/login/token/refresh']) {
    cookies.push(
      `MUSIC_R_U=00DE2BE5D54B5B01B83CC1A646BD07C2A4F11FAE2FABD5F60793BDF26A15167CC5AA314B4E83A6132F57339D211CF3F8DC18515847E544FC0B1246B3F35439FA1F768D036F7FBDF874AEC4A1D65739F601; Max-Age=15552000; Expires=Wed, 31 Mar 2027 17:41:51 GMT; Path=/${scope};`,
    )
  }
  return cookies
}

/** 会话必需 cookie 白名单：测试独立维护字面量，避免与实现同源导致断言失真。 */
const SESSION_COOKIE_NAMES = ['MUSIC_U', '__csrf', 'MUSIC_A', 'NMTID']
const cookieName = (setCookie: string) =>
  setCookie.slice(0, setCookie.indexOf('='))

describe('扫码登录 803 响应', () => {
  it('只下发会话必需的 cookie，避免大响应头触发网关 502', async () => {
    qrCheckMock.mockResolvedValue({ code: 803, cookies: loginCookies() })
    loginStatusMock.mockResolvedValue({
      logged: true,
      nickname: 'tester',
      vip: true,
    })

    const res = await app.request('/api/auth/qr/check?key=test-key')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      data: { code: number; logged?: boolean; loginable?: boolean }
    }
    expect(body.ok).toBe(true)
    expect(body.data.code).toBe(803)
    expect(body.data.logged).toBe(true)
    // 必须带 `loginable`：否则前端写入登录态时丢该字段，会把该源从登录弹窗的 tab 列表里滤掉
    expect(body.data.loginable).toBe(true)

    const setCookies = res.headers.getSetCookie()
    const names = setCookies.map(cookieName)
    // 会话 cookie 只含网易云白名单项
    for (const n of SESSION_COOKIE_NAMES) expect(names).toContain(n)
    // 其余只可能是「单活动账号」清掉的其它源（B 站）会话 cookie——不透传上游数十条无关 cookie
    const allowed = new Set<string>([
      ...SESSION_COOKIE_NAMES,
      ...BILIBILI_SESSION_COOKIE_NAMES,
    ])
    expect(names.every((n) => allowed.has(n))).toBe(true)
    // 登入网易云时，B 站的会话 cookie 被清（单活动账号，含 MV 渠道）
    const otherClears = setCookies.filter((c) =>
      /^(SESSDATA|bili_jct|DedeUserID)=;/.test(c),
    )
    expect(otherClears.length).toBeGreaterThan(0)
    // 响应头仍克制（不因透传无关 cookie 而撑大）
    expect(setCookies.join('\n').length).toBeLessThan(2048)
  })

  it('803 下发的 cookie 会被后续请求回读并透传网易云', async () => {
    qrCheckMock.mockResolvedValue({ code: 803, cookies: loginCookies() })
    loginStatusMock.mockResolvedValue({ logged: true, nickname: 'tester' })

    const checkRes = await app.request('/api/auth/qr/check?key=test-key')
    const cookieHeader = checkRes.headers
      .getSetCookie()
      .map((sc) => sc.split(';')[0])
      .join('; ')

    const statusRes = await app.request('/api/auth/status', {
      headers: { cookie: cookieHeader },
    })
    expect(statusRes.status).toBe(200)
    const forwarded = loginStatusMock.mock.calls.at(-1)?.[0]
    expect(forwarded).toContain('MUSIC_U=')
    expect(forwarded).toContain('__csrf=')
    expect(forwarded).toContain('NMTID=')
  })

  it('未登录状态（801）不下发任何 cookie', async () => {
    qrCheckMock.mockResolvedValue({ code: 801, message: '等待扫码' })

    const res = await app.request('/api/auth/qr/check?key=test-key')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { code: number } }
    expect(body.ok).toBe(true)
    expect(body.data.code).toBe(801)
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe('服务端缺省凭证（NETEASE_COOKIE）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('未登录访客的内容请求透传缺省凭证', async () => {
    vi.stubEnv('NETEASE_COOKIE', 'MUSIC_U=default; __csrf=d')
    searchSongsMock.mockResolvedValue([])

    const res = await app.request('/api/search?keywords=test')
    expect(res.status).toBe(200)
    expect(searchSongsMock.mock.calls.at(-1)?.[2]).toBe(
      'MUSIC_U=default; __csrf=d',
    )
  })

  it('访客本人会话优先于缺省凭证', async () => {
    vi.stubEnv('NETEASE_COOKIE', 'MUSIC_U=default')
    searchSongsMock.mockResolvedValue([])

    await app.request('/api/search?keywords=test', {
      headers: { cookie: 'MUSIC_U=mine; __csrf=m' },
    })
    expect(searchSongsMock.mock.calls.at(-1)?.[2]).toBe(
      'MUSIC_U=mine; __csrf=m',
    )
  })

  it('缺省凭证不影响身份：auth/status 仍为未登录', async () => {
    vi.stubEnv('NETEASE_COOKIE', 'MUSIC_U=default')
    loginStatusMock.mockResolvedValue({ logged: false })

    const res = await app.request('/api/auth/status')
    expect(await res.json()).toEqual({
      ok: true,
      data: { logged: false, loginable: true },
    })
    // 身份判断没有把缺省凭证透传进去
    expect(loginStatusMock.mock.calls.at(-1)?.[0]).toBeUndefined()
  })
})

describe('退出登录与会话自愈', () => {
  it('登出清空该源**全部**会话 cookie（含曾漏掉的 MUSIC_A / NMTID）', async () => {
    const res = await app.request('/api/auth/netease/logout', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie()
    const names = setCookies.map(cookieName)
    for (const n of SESSION_COOKIE_NAMES) expect(names).toContain(n)
    for (const c of setCookies) expect(c).toContain('Max-Age=0')
    // 只清会话名单内的项，不误伤无关 cookie
    expect(names.every((n) => SESSION_COOKIE_NAMES.includes(n))).toBe(true)
  })

  it('登录态查询发现「有会话 cookie 却未登录」时，清空该源全部会话 cookie（自愈）', async () => {
    loginStatusMock.mockResolvedValue({ logged: false })
    const res = await app.request('/api/auth/netease/status', {
      headers: { cookie: 'MUSIC_A=stale; NMTID=stale' },
    })
    expect(res.status).toBe(200)
    const names = res.headers.getSetCookie().map(cookieName)
    for (const n of SESSION_COOKIE_NAMES) expect(names).toContain(n)
  })

  it('未带会话 cookie 查询登录态时不下发清理（不误伤匿名访客）', async () => {
    loginStatusMock.mockResolvedValue({ logged: false })
    const res = await app.request('/api/auth/netease/status')
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('已登录时不清会话 cookie', async () => {
    loginStatusMock.mockResolvedValue({ logged: true, nickname: 'me' })
    const res = await app.request('/api/auth/netease/status', {
      headers: { cookie: 'MUSIC_U=ok' },
    })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('各源登出清理名单覆盖其会话名单（防再次漏清）', () => {
    for (const a of [neteaseAdapter, bilibiliAdapter]) {
      const logouts = new Set(a.logoutCookieNames)
      for (const n of a.sessionCookieNames) expect(logouts.has(n)).toBe(true)
    }
  })
})

describe('源段与缺省源', () => {
  it('3 段式 /stream/:source/:id 与 2 段式别名均可用（未知源 404）', async () => {
    vi.spyOn(neteaseAdapter, 'songUrl').mockResolvedValue([])
    expect((await app.request('/stream/netease/123')).status).toBe(403) // 解析失败 → 403
    expect((await app.request('/stream/123')).status).toBe(403) // 2 段别名 → 缺省源
    expect((await app.request('/stream/spotify/123')).status).toBe(404) // 未知源
  })

  it('/stream 的 level query 透传给适配器；非法档回退缺省 exhigh', async () => {
    const ne = vi.spyOn(neteaseAdapter, 'songUrl').mockResolvedValue([])
    await app.request('/stream/netease/123?level=lossless')
    expect(ne).toHaveBeenCalledWith('123', undefined, 'lossless')
    await app.request('/stream/netease/456?level=bogus')
    expect(ne).toHaveBeenLastCalledWith('456', undefined, 'exhigh')
  })

  it('搜索按 source 查询参数分派到对应适配器', async () => {
    searchSongsMock.mockResolvedValue([])
    const ne = await app.request('/api/search?keywords=x')
    expect(ne.status).toBe(200)
    expect(searchSongsMock).toHaveBeenCalledWith(
      'x',
      expect.any(Number),
      undefined,
      1,
    )
  })

  it('/stream 按候选顺序回退：首个 CDN 失败则改用下一个', async () => {
    vi.spyOn(neteaseAdapter, 'songUrl').mockResolvedValue([
      'https://bad.example/a.mp3',
      'https://good.example/b.mp3',
    ])
    const tried: string[] = []
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        tried.push(url)
        return url.includes('bad.example')
          ? new Response('nope', { status: 403 })
          : new Response('bytes', {
              status: 200,
              headers: { 'content-type': 'audio/mpeg' },
            })
      })
    const res = await app.request('/stream/netease/cand-1')
    expect(res.status).toBe(200)
    expect(tried).toEqual([
      'https://bad.example/a.mp3',
      'https://good.example/b.mp3',
    ])
    fetchMock.mockRestore()
  })

  it('/stream 候选全部失败 → 502 并淘汰缓存（供下次重解析）', async () => {
    const songUrlMock = vi
      .spyOn(neteaseAdapter, 'songUrl')
      .mockResolvedValue(['https://bad.example/a.mp3'])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('x', { status: 403 }))
    const first = await app.request('/stream/netease/cand-2')
    expect(first.status).toBe(502)
    // 缓存已被淘汰：再次请求会重新解析（songUrl 被第二次调用）
    await app.request('/stream/netease/cand-2')
    expect(songUrlMock).toHaveBeenCalledTimes(2)
    fetchMock.mockRestore()
  })
})

describe('搜索分页（page / type）', () => {
  it('/api/search 把 page 透传给适配器（缺省 1）', async () => {
    searchSongsMock.mockResolvedValue([])
    await app.request('/api/search?keywords=x&page=3')
    expect(searchSongsMock).toHaveBeenLastCalledWith(
      'x',
      expect.any(Number),
      undefined,
      3,
    )
  })

  it('/api/search/all 把 page 透传给单曲搜索（限 50）', async () => {
    searchSongsMock.mockResolvedValue([])
    await app.request('/api/search/all?keywords=x&page=2')
    expect(searchSongsMock).toHaveBeenLastCalledWith('x', 50, undefined, 2)
  })

  it('/api/search/all?type=songs 只跑歌曲一类（其余不请求上游）', async () => {
    searchSongsMock.mockResolvedValue([])
    const artists = vi.spyOn(neteaseAdapter, 'searchArtists')
    const res = await app.request('/api/search/all?keywords=x&type=songs')
    const body = (await res.json()) as {
      data: { artists: unknown[]; capabilities: Record<string, boolean> }
    }
    expect(res.status).toBe(200)
    expect(artists).not.toHaveBeenCalled()
    expect(body.data.artists).toEqual([])
    // capabilities 仍如实反映能力（前端据此显示 tab），不因 type 过滤而收窄
    expect(body.data.capabilities.artists).toBe(true)
  })
})

describe('音频响应 Content-Type（按直链后缀，纠正上游谎报）', () => {
  it('无损直链 .flac → audio/flac（上游谎报 audio/mpeg 时以此为准）', () => {
    expect(audioContentTypeFromUrl('https://cdn.example/x.flac?auth=1')).toBe(
      'audio/flac',
    )
  })

  it('.mp3 / .m4s / .wav / .ogg 等映射', () => {
    expect(audioContentTypeFromUrl('https://cdn.example/x.mp3')).toBe(
      'audio/mpeg',
    )
    expect(audioContentTypeFromUrl('https://cdn.example/x.m4s?x=1')).toBe(
      'audio/mp4',
    )
    expect(audioContentTypeFromUrl('https://cdn.example/x.wav')).toBe(
      'audio/wav',
    )
    expect(audioContentTypeFromUrl('https://cdn.example/x.ogg')).toBe(
      'audio/ogg',
    )
  })

  it('无后缀 / 非法地址 → undefined（调用方回退上游头）', () => {
    expect(audioContentTypeFromUrl('https://cdn.example/x')).toBeUndefined()
    expect(audioContentTypeFromUrl('not a url')).toBeUndefined()
  })
})

describe('MV 渠道（B 站，独立于音乐源）', () => {
  it('/auth/bilibili/status 标记 loginable:true（支持扫码登录）', async () => {
    vi.spyOn(bilibiliAdapter, 'loginStatus').mockResolvedValue({
      logged: false,
    })
    const res = await app.request('/api/auth/bilibili/status')
    expect(await res.json()).toEqual({
      ok: true,
      data: { logged: false, loginable: true },
    })
  })

  it('/stream/bilibili/:id 解析失败回 403 且 needLogin', async () => {
    vi.spyOn(bilibiliAdapter, 'songUrl').mockResolvedValue([])
    const res = await app.request('/stream/bilibili/BV1xx411c7mD')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, needLogin: true })
  })

  it('/api/search/all?source=bilibili 只标 songs 能力', async () => {
    vi.spyOn(bilibiliAdapter, 'searchSongs').mockResolvedValue([])
    const res = await app.request('/api/search/all?keywords=x&source=bilibili')
    const body = (await res.json()) as {
      ok: boolean
      data: { capabilities: Record<string, boolean> }
    }
    expect(res.status).toBe(200)
    expect(body.data.capabilities).toEqual({
      songs: true,
      artists: false,
      albums: false,
      playlists: false,
    })
  })
})

describe('分P 展开（/api/parts）', () => {
  it('B 站：3 段式返回适配器给出的分P；2 段式别名回落到缺省源（网易云无此能力 → 501）', async () => {
    const parts = [
      {
        source: 'bilibili' as const,
        id: 'BV1xx:111',
        title: 'P1 · a',
        artist: 'up',
        album: '',
        cover: '',
        duration: 10,
        fee: 'free' as const,
      },
    ]
    vi.spyOn(bilibiliAdapter, 'parts').mockResolvedValue(parts)
    const res = await app.request('/api/parts/bilibili/BV1xx')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: parts })
    expect((await app.request('/api/parts/BV1xx')).status).toBe(501)
  })

  it('无 parts 能力的源回 501（而非 404/502）', async () => {
    expect((await app.request('/api/parts/netease/123')).status).toBe(501)
  })
})
