import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../src/api/client.js'

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api.client', () => {
  it('成功时解包 ApiResult.data', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(jsonRes({ ok: true, data: [] })),
    )
    await expect(api.search('netease', 'x')).resolves.toEqual([])
  })

  it('失败时抛 ApiError，并带上 status 与 needLogin', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        jsonRes({ ok: false, error: '未登录', needLogin: true }, 401),
      ),
    )
    const err = await api.authStatus('netease').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const e = err as ApiError
    expect(e.status).toBe(401)
    expect(e.needLogin).toBe(true)
    expect(e.message).toBe('未登录')
  })

  it('写请求的失败同样带 status（此前 send 不设）', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(jsonRes({ ok: false, error: '云端副本损坏' }, 502)),
    )
    const err = await api
      .syncPut({
        favorites: [],
        recent: [],
        playlists: [],
        savedPlaylists: [],
        savedAlbums: [],
        savedArtists: [],
      } as never)
      .catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(502)
  })

  it('网络异常归一为 status=0 的 ApiError', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('net down')))
    const err = await api.recommend('netease').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('非 JSON 响应也归一为 ApiError', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      }),
    )
    const err = await api.recommend('netease').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).message).toContain('500')
  })

  it('批量 id 先拼接再整体编码（含逗号的 id 不会被切错）', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      calls.push(String(input))
      return Promise.resolve(jsonRes({ ok: true, data: [] }))
    })
    await api.songs('netease', ['1', '2,3', '4'])
    expect(calls[0]).toBe('/api/songs?ids=1%2C2%2C3%2C4&source=netease')
  })

  it('查询参数中的空值被省略', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      calls.push(String(input))
      return Promise.resolve(jsonRes({ ok: true, data: [] }))
    })
    await api.userPlaylists()
    expect(calls[0]).toBe('/api/user/playlists')
  })
})
