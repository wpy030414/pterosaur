import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LibraryData } from '@pterosaur/shared/types'
import { createApp } from '../src/app.js'
import { neteaseAdapter } from '../src/sources/netease.js'
import { bilibiliAdapter } from '../src/sources/bilibili.js'
import { broadcast, subscriberCount, subscribe } from '../src/syncEvents.js'
import { closeSyncDb } from '../src/syncDb.js'

const app = createApp()

const state = (): LibraryData => ({
  favorites: [],
  recent: [],
  playlists: [],
  savedPlaylists: [],
  savedArtists: [],
  savedAlbums: [],
})

/** 身份来自访客 cookie：把 netease 置为已登录、bilibili 置为未登录，避免触网。 */
const LOGIN_COOKIE = 'MUSIC_U=fake-session'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pterosaur-syncroutes-'))
  process.env.DATA_DIR = dir
  vi.spyOn(neteaseAdapter, 'loginStatus').mockResolvedValue({
    logged: true,
    userId: '9',
  })
  vi.spyOn(bilibiliAdapter, 'loginStatus').mockResolvedValue({ logged: false })
})

afterEach(() => {
  closeSyncDb(dir)
  delete process.env.DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('云同步注册表', () => {
  it('订阅 / 广播 / 幂等退订', () => {
    const stream = { writeSSE: vi.fn(async () => {}) }
    const off = subscribe('k', stream as never)
    expect(subscriberCount('k')).toBe(1)

    broadcast('k', { rev: 3 })
    expect(stream.writeSSE).toHaveBeenCalledWith({
      event: 'rev',
      data: JSON.stringify({ rev: 3 }),
    })

    off()
    expect(subscriberCount('k')).toBe(0)
    off() // 幂等
    expect(subscriberCount('k')).toBe(0)
  })

  it('无订阅时广播不报错', () => {
    expect(() => broadcast('none', { rev: 1 })).not.toThrow()
  })
})

describe('云同步路由', () => {
  it('未登录读 / 写均 401', async () => {
    vi.mocked(neteaseAdapter.loginStatus).mockResolvedValue({ logged: false })
    const get = await app.request('/api/sync/library')
    expect(get.status).toBe(401)
    const put = await app.request('/api/sync/library', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state() }),
    })
    expect(put.status).toBe(401)
  })

  it('PUT 指派服务端 rev，GET 读回', async () => {
    const put = await app.request('/api/sync/library', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: LOGIN_COOKIE },
      body: JSON.stringify({ state: state() }),
    })
    expect(put.status).toBe(200)
    const putJson = (await put.json()) as { data: { rev: number } }
    expect(putJson.data.rev).toBe(1)

    const get = await app.request('/api/sync/library', {
      headers: { Cookie: LOGIN_COOKIE },
    })
    const getJson = (await get.json()) as {
      data: { payload: { rev: number } }
    }
    expect(getJson.data.payload.rev).toBe(1)
  })

  it('PUT 非法载荷 400', async () => {
    const res = await app.request('/api/sync/library', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: LOGIN_COOKIE },
      body: JSON.stringify({ state: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT 成功后向同账号的其它连接广播 { rev }', async () => {
    const stream = { writeSSE: vi.fn(async () => {}) }
    const off = subscribe('netease-9', stream as never)
    await app.request('/api/sync/library', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: LOGIN_COOKIE },
      body: JSON.stringify({ state: state() }),
    })
    expect(stream.writeSSE).toHaveBeenCalledWith({
      event: 'rev',
      data: JSON.stringify({ rev: 1 }),
    })
    off()
  })

  it('SSE 端点返回事件流，未登录 401', async () => {
    vi.mocked(neteaseAdapter.loginStatus).mockResolvedValue({ logged: false })
    const unauth = await app.request('/api/sync/events')
    expect(unauth.status).toBe(401)
  })
})
