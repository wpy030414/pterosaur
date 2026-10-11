import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { Track } from '@pterosaur/shared/types'
import type { RipEvent } from '@pterosaur/shared/rip'
import { createApp } from '../src/app.js'
import { neteaseAdapter } from '../src/sources/netease.js'
import {
  _resetRipForTest,
  isAllowedCoverUrl,
  lastResultSnapshot,
  ripCapabilities,
  sanitizeVolumeLabel,
  subscribeRip,
  validateBurnBody,
} from '../src/rip.js'
import { toCdPcm } from '../src/ffmpeg.js'
import { probeDisc } from '../src/imapi.js'
import { fakeProbe } from '../src/imapiFake.js'

// 转码在单测里不落真实二进制：ffmpeg 模块整体替换（音频分支只关心编排）
vi.mock('../src/ffmpeg.js', () => ({
  resolveFfmpegPath: vi.fn(async () => 'fake-ffmpeg'),
  ffmpegVersion: vi.fn(async () => 'test'),
  toCdPcm: vi.fn(async () => {}),
  padToCdSector: vi.fn(async () => {}),
  _resetFfmpegForTest: vi.fn(),
}))

// 刻录侧（probe/burn）经 imapiFake 替换，但 `isFakeBurn` 保持 false——
// 让单测走**真实取流路径**（songUrl spy + 假 fetch），与模拟模式的封闭链路互补
vi.mock('../src/imapi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/imapi.js')>()
  const fake = await import('../src/imapiFake.js')
  return {
    ...real,
    isFakeBurn: () => false,
    probeDisc: vi.fn(() => fake.fakeProbe()),
    burnDisc: vi.fn(
      (
        req: Parameters<typeof fake.fakeBurn>[0],
        onEvent: Parameters<typeof fake.fakeBurn>[1],
      ) => fake.fakeBurn(req, onEvent),
    ),
  }
})

const app = createApp()

/** 回环 / 远端两种连接环境（getConnInfo 读 env.incoming.socket.remoteAddress）。 */
const loopbackEnv = {
  incoming: {
    socket: { remoteAddress: '127.0.0.1', remotePort: 1, remoteFamily: 'IPv4' },
  },
} as never
const remoteEnv = {
  incoming: {
    socket: { remoteAddress: '10.0.0.5', remotePort: 1, remoteFamily: 'IPv4' },
  },
} as never

const track = (id: string, over: Partial<Track> = {}): Track => ({
  source: 'netease',
  id,
  title: `曲-${id}`,
  artist: '艺人',
  album: '专辑',
  cover: 'https://p3.music.126.net/x.jpg',
  duration: 180,
  fee: 'free',
  ...over,
})

const validBody = (over: Record<string, unknown> = {}) => ({
  meta: {
    kind: 'playlist',
    name: '测试合集',
    sourceId: '42',
    coverUrl: 'https://p3.music.126.net/cover.jpg',
  },
  tracks: [track('a'), track('b')],
  discType: 'data',
  level: 'exhigh',
  ...over,
})

/** 假的 web 流响应体（jsdom 环境无全局 ReadableStream，取 node:stream/web 同类）。 */
const webBody = () =>
  new NodeWebReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3, 4]))
      c.close()
    },
  })

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<unknown> => {
      const url = String(input)
      if (url.includes('/cover')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (): string | null => 'image/png' },
          arrayBuffer: async (): Promise<ArrayBuffer> =>
            new Uint8Array([137, 80, 78, 71]).buffer,
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => 'audio/flac' },
        body: webBody(),
      }
    }),
  )
}

const burnRequest = (body: unknown, env: unknown) =>
  app.request(
    '/api/rip/burn',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env as never,
  )

/** 等待任务到 done 终态（模拟刻录刻意放慢 ~0.5s，waitFor 默认 1s 太紧）。 */
const waitDone = () =>
  vi.waitFor(() => expect(lastResultSnapshot()?.status).toBe('done'), {
    timeout: 8000,
  })

beforeEach(() => {
  _resetRipForTest()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  _resetRipForTest()
})

describe('validateBurnBody', () => {
  it('接受合法载荷并归一 meta（同源、physical）', () => {
    const v = validateBurnBody(validBody())
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.value.meta.distribution).toBe('physical')
    expect(v.value.meta.discType).toBe('data')
    expect(v.value.meta.source).toBe('netease')
    expect(v.value.tracks).toHaveLength(2)
  })

  it('拒绝非法载荷', () => {
    expect(validateBurnBody(null).ok).toBe(false)
    expect(validateBurnBody(validBody({ tracks: [] })).ok).toBe(false)
    expect(validateBurnBody(validBody({ discType: 'dvd' })).ok).toBe(false)
    expect(validateBurnBody(validBody({ level: 'ultra' })).ok).toBe(false)
    expect(
      validateBurnBody(validBody({ meta: { kind: 'mix', name: 'x' } })).ok,
    ).toBe(false)
    expect(
      validateBurnBody(validBody({ meta: { kind: 'album', name: '  ' } })).ok,
    ).toBe(false)
    expect(
      validateBurnBody(
        validBody({
          tracks: [track('a'), { ...track('b'), source: 'bilibili' }],
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('跨多个音源') })
    expect(
      validateBurnBody(
        validBody({ tracks: [{ ...track('a'), duration: NaN }] }),
      ).ok,
    ).toBe(false)
    const many = Array.from({ length: 501 }, (_, i) => track(`t${i}`))
    expect(validateBurnBody(validBody({ tracks: many })).ok).toBe(false)
  })

  it('音频 CD 超时长拒绝', () => {
    const long = track('a', { duration: 4740 })
    const v = validateBurnBody(validBody({ discType: 'audio', tracks: [long] }))
    expect(v).toMatchObject({
      ok: false,
      error: expect.stringContaining('超出音频 CD 上限'),
    })
  })
})

describe('sanitizeVolumeLabel', () => {
  it('仅保留 ISO9660 安全字符并大写', () => {
    expect(sanitizeVolumeLabel('Mix 1: Hits!')).toBe('MIX 1 HITS')
    expect(sanitizeVolumeLabel('我喜欢的音乐')).toBe('PTEROSAUR')
    expect(sanitizeVolumeLabel('')).toBe('PTEROSAUR')
    expect(sanitizeVolumeLabel('a'.repeat(80)).length).toBeLessThanOrEqual(32)
    expect(sanitizeVolumeLabel('  . x .  ')).toBe('X')
  })
})

describe('isAllowedCoverUrl', () => {
  it('白名单主机 + https 才放行', () => {
    expect(isAllowedCoverUrl('https://p3.music.126.net/x.jpg')).toBe(true)
    expect(isAllowedCoverUrl('https://i0.hdslb.com/x.jpg')).toBe(true)
    expect(isAllowedCoverUrl('http://p3.music.126.net/x.jpg')).toBe(false)
    expect(isAllowedCoverUrl('https://evil.com/x.jpg')).toBe(false)
    expect(isAllowedCoverUrl('https://music.126.net.evil.com/x')).toBe(false)
    expect(isAllowedCoverUrl('https://127.0.0.1/x')).toBe(false)
    expect(isAllowedCoverUrl('not a url')).toBe(false)
  })
})

describe('回环门控', () => {
  it('回环放行 / 远端 403 / 缺连接信息 fail-closed', async () => {
    expect((await app.request('/api/rip/status', {}, loopbackEnv)).status).toBe(
      200,
    )
    expect((await app.request('/api/rip/status', {}, remoteEnv)).status).toBe(
      403,
    )
    expect((await app.request('/api/rip/status')).status).toBe(403)
    expect(
      (await app.request('/api/rip/capabilities', {}, remoteEnv)).status,
    ).toBe(403)
    expect((await burnRequest(validBody(), remoteEnv)).status).toBe(403)
  })

  it('ripCapabilities：模拟环境下报告可用刻录机与 ffmpeg', async () => {
    const caps = await ripCapabilities()
    expect(caps.simulated).toBe(true)
    expect(caps.supported).toBe(true)
    expect(caps.recorders).toHaveLength(1)
    expect(caps.media.blank).toBe(true)
    expect(caps.media.dataSupported).toBe(true)
    expect(caps.media.audioSupported).toBe(true)
    expect(caps.ffmpeg.available).toBe(true)
    expect(caps.audioCd.maxSeconds).toBe(79 * 60)
  })

  it('介质不支持目标格式：先行失败（在拉取任何音频之前）', async () => {
    vi.mocked(probeDisc).mockResolvedValueOnce({
      ...fakeProbe(),
      dataSupported: false,
    })
    const songUrl = vi
      .spyOn(neteaseAdapter, 'songUrl')
      .mockResolvedValue(['https://cdn.example/x.flac'])

    expect((await burnRequest(validBody(), loopbackEnv)).status).toBe(202)
    await vi.waitFor(
      () => {
        expect(lastResultSnapshot()?.status).toBe('error')
      },
      { timeout: 8000 },
    )
    expect(lastResultSnapshot()?.error).toContain('不支持数据刻录')
    expect(songUrl).not.toHaveBeenCalled()
  })
})

describe('刻录任务（模拟刻录 + 假取流）', () => {
  it('数据 CD 全流程：202 → fetch 进度 → done → meta 含逐曲文件与封面', async () => {
    stubFetch()
    const songUrl = vi
      .spyOn(neteaseAdapter, 'songUrl')
      .mockResolvedValue(['https://cdn.example/x.flac'])
    const events: RipEvent[] = []
    subscribeRip((ev) => events.push(ev))

    const res = await burnRequest(validBody(), loopbackEnv)
    expect(res.status).toBe(202)
    const { data } = (await res.json()) as { data: { jobId: string } }
    expect(data.jobId).toMatch(/^burn-/)

    await waitDone()
    const result = lastResultSnapshot()!
    expect(result.meta?.discType).toBe('data')
    expect(result.meta?.tracks[0].file).toBe('1 - 曲-a.flac')
    expect(result.meta?.cover).toEqual({
      file: 'cover.png',
      url: 'https://p3.music.126.net/cover.jpg',
    })

    expect(songUrl).toHaveBeenCalled()
    expect(
      events.some((e) => e.type === 'progress' && e.phase === 'fetch'),
    ).toBe(true)
    expect(
      events.some((e) => e.type === 'progress' && e.phase === 'burn'),
    ).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })

  it('并发发起回 409（任务进行中）', async () => {
    stubFetch()
    vi.spyOn(neteaseAdapter, 'songUrl').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200))
      return ['https://cdn.example/x.flac']
    })
    expect((await burnRequest(validBody(), loopbackEnv)).status).toBe(202)
    expect((await burnRequest(validBody(), loopbackEnv)).status).toBe(409)
    await waitDone()
  })

  it('单轨不可获取即 fail-fast（错误事件 + 终态 error）', async () => {
    stubFetch()
    vi.spyOn(neteaseAdapter, 'songUrl').mockResolvedValue([])
    const events: RipEvent[] = []
    subscribeRip((ev) => events.push(ev))

    expect((await burnRequest(validBody(), loopbackEnv)).status).toBe(202)
    await vi.waitFor(
      () => {
        expect(lastResultSnapshot()?.status).toBe('error')
      },
      { timeout: 8000 },
    )
    const err = events.find((e) => e.type === 'error')
    expect(err && err.type === 'error' ? err.message : '').toContain('不可获取')
  })

  it('音频 CD：转码阶段事件 + meta 无逐曲文件、无封面', async () => {
    stubFetch()
    vi.spyOn(neteaseAdapter, 'songUrl').mockResolvedValue([
      'https://cdn.example/x.flac',
    ])
    const events: RipEvent[] = []
    subscribeRip((ev) => events.push(ev))

    const res = await burnRequest(
      validBody({ discType: 'audio', tracks: [track('a')] }),
      loopbackEnv,
    )
    expect(res.status).toBe(202)
    await waitDone()
    const result = lastResultSnapshot()!
    expect(result.meta?.discType).toBe('audio')
    expect(result.meta?.tracks[0].file).toBeUndefined()
    expect(result.meta?.cover).toBeUndefined()
    expect(vi.mocked(toCdPcm)).toHaveBeenCalledTimes(1)
    expect(
      events.some((e) => e.type === 'progress' && e.phase === 'convert'),
    ).toBe(true)
  })
})
