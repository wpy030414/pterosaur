import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizeTrack,
  normalizeArtist,
  normalizeAlbum,
  qrKey,
  qrLoginUrl,
  qrCheck,
  qrCreate,
} from '../../src/sources/netease.js'
import { NETEASE_IMAGE_HOST } from '@pterosaur/shared/image'

describe('normalizeTrack', () => {
  it('填充 artistRefs 与 albumId，并把封面改写为 https + 固定镜像主机', () => {
    const t = normalizeTrack({
      id: 1,
      name: '歌',
      fee: 0,
      dt: 200_000,
      ar: [
        { id: 10, name: '甲' },
        { id: 20, name: '乙' },
      ],
      al: { id: 99, name: '专辑', picUrl: 'http://p1.music.126.net/x.jpg' },
    })
    expect(t.artist).toBe('甲 / 乙')
    expect(t.artistRefs).toEqual([
      { id: '10', name: '甲' },
      { id: '20', name: '乙' },
    ])
    expect(t.albumId).toBe('99')
    expect(t.album).toBe('专辑')
    // 规范化：https + 固定镜像主机 + 统一尺寸（网易云会随机轮换 p1–pN，见 ADR-020）
    expect(t.cover).toBe(`https://${NETEASE_IMAGE_HOST}/x.jpg?param=1200y1200`)
    expect(t.duration).toBe(200)
  })

  it('封面地址已有 param 时被统一尺寸覆盖（不产生双 param 碎片）', () => {
    const t = normalizeTrack({
      id: 3,
      name: '歌',
      ar: [],
      al: {
        id: 1,
        name: '专辑',
        picUrl: 'http://p4.music.126.net/y.jpg?param=200y200',
      },
    })
    expect(t.cover).toBe(`https://${NETEASE_IMAGE_HOST}/y.jpg?param=1200y1200`)
  })

  it('缺少 id 时 artistRefs / albumId 为 undefined（供前端降级为纯文本）', () => {
    const t = normalizeTrack({
      id: 2,
      name: 'x',
      ar: [{ name: '甲' }],
      al: { name: '专辑' },
    })
    expect(t.artistRefs).toBeUndefined()
    expect(t.albumId).toBeUndefined()
    expect(t.artist).toBe('甲')
    expect(t.album).toBe('专辑')
  })
})

describe('normalizeArtist', () => {
  it('归一化头像为 https + 固定镜像主机并保留统计信息', () => {
    const a = normalizeArtist({
      id: 5,
      name: '某艺人',
      picUrl: 'http://p7.music.126.net/a.jpg',
      albumSize: 3,
      musicSize: 20,
      alias: ['别名'],
    })
    expect(a.id).toBe('5')
    expect(a.avatar).toBe(`https://${NETEASE_IMAGE_HOST}/a.jpg?param=1200y1200`)
    expect(a.albumSize).toBe(3)
    expect(a.musicSize).toBe(20)
    expect(a.alias).toEqual(['别名'])
  })
})

describe('normalizeAlbum', () => {
  it('取主艺人 id 与发行年份；封面规范化', () => {
    const al = normalizeAlbum({
      id: 7,
      name: '某专辑',
      picUrl: 'http://p2.music.126.net/b.jpg',
      artists: [
        { id: 3, name: '甲' },
        { id: 4, name: '乙' },
      ],
      size: 10,
      publishTime: Date.UTC(2020, 5, 15, 12),
    })
    expect(al.id).toBe('7')
    expect(al.artist).toBe('甲 / 乙')
    expect(al.artistId).toBe('3')
    // 合作专辑：每个艺人都带 id，供界面逐个跳转（此前只有整体名串，只能跳到第一个）
    expect(al.artistRefs).toEqual([
      { id: '3', name: '甲' },
      { id: '4', name: '乙' },
    ])
    expect(al.year).toBe(2020)
    expect(al.trackCount).toBe(10)
    expect(al.cover).toBe(`https://${NETEASE_IMAGE_HOST}/b.jpg?param=1200y1200`)
  })

  it('缺少艺人 id 时 artistRefs 缺省，artistId 亦缺省', () => {
    const al = normalizeAlbum({ id: 8, name: '无名专辑', artist: { name: '甲' } })
    expect(al.artist).toBe('甲')
    expect(al.artistRefs).toBeUndefined()
    expect(al.artistId).toBeUndefined()
  })
})

/**
 * 扫码登录走现行网页协议（明文 `/api/login/qrcode/*` + `type=1` + `st/platform/scanlogin`），
 * 不再复用库里的 `login_qr_*`（eapi + `type=3` + 旧二维码链接，2026-10 起失效）。
 * 这里 mock 全局 fetch，断言请求形态与响应收敛。
 */
describe('扫码登录（现行网页协议）', () => {
  const fetchMock = vi.fn()

  /** 造一个最小 Response，可带若干 Set-Cookie。 */
  function respond(body: unknown, setCookies: string[] = []) {
    return {
      text: async () => JSON.stringify(body),
      headers: { getSetCookie: () => setCookies },
    }
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('qrKey 用 type=1 明文 POST 取 unikey', async () => {
    fetchMock.mockResolvedValue(respond({ code: 200, unikey: 'k-1' }))
    await expect(qrKey()).resolves.toBe('k-1')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://music.163.com/api/login/qrcode/unikey')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toBe('type=1')
  })

  it('qrCreate 生成的二维码内容即现行扫码落地页，且与轮询共用同一 chainId', async () => {
    fetchMock.mockResolvedValue(respond({ code: 200, unikey: 'k-2' }))
    const key = await qrKey()
    const url = new URL(await qrLoginUrl(key))
    expect(url.origin + url.pathname).toBe(
      'https://music.163.com/st/platform/scanlogin',
    )
    expect(url.searchParams.get('codekey')).toBe(key)
    expect(url.searchParams.get('hdw_device')).toBe('web')
    expect(url.searchParams.get('hdw_appid')).toBe('web')
    const chainId = url.searchParams.get('chainId')
    expect(chainId).toMatch(/^v1_unknown-\d+_web_login_\d+$/)

    const img = await qrCreate(key)
    expect(img.startsWith('data:image/png;base64,')).toBe(true)

    // 轮询：type=1 + noCheckToken + X-loginMethod + 同一条 chainId
    fetchMock.mockResolvedValue(respond({ code: 801, message: '等待扫码' }, []))
    const res = await qrCheck(key)
    expect(res.code).toBe(801)
    const [u, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(u).toBe('https://music.163.com/api/login/qrcode/client/login')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('type')).toBe('1')
    expect(body.get('noCheckToken')).toBe('true')
    expect(body.get('key')).toBe(key)
    const headers = init.headers as Record<string, string>
    expect(headers['X-loginMethod']).toBe('QrCode')
    expect(headers['x-login-chain-id']).toBe(chainId)
  })

  it('qrCheck 803 透传 Set-Cookie；非 JSON 响应按过期处理', async () => {
    const cookies = [
      'MUSIC_U=abc; Path=/;',
      '__csrf=def; Path=/;',
      'NMTID=ghi; Path=/;',
    ]
    fetchMock.mockResolvedValue(respond({ code: 803 }, cookies))
    const ok = await qrCheck('k-3')
    expect(ok.code).toBe(803)
    expect(ok.cookies).toEqual(cookies)

    fetchMock.mockResolvedValue({
      text: async () => '<html>oops</html>',
      headers: { getSetCookie: () => [] },
    })
    const bad = await qrCheck('k-4')
    expect(bad.code).toBe(800)
  })
})
