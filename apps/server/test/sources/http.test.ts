import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  STREAM_EXPIRY_MARGIN_MS,
  UpstreamError,
  businessError,
  codecName,
  credentialFingerprint,
  isTransientError,
  makeQuality,
  parseSampleRate,
  sessionCookieHeader,
  toHttps,
  upstreamExpiresAt,
  upstreamJson,
} from '../../src/sources/http.js'

const jsonRes = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
})

describe('sources/http 通用工具', () => {
  it('toHttps 只改写 http 前缀，https 原样返回', () => {
    expect(toHttps('http://cdn.example/a.mp3')).toBe(
      'https://cdn.example/a.mp3',
    )
    expect(toHttps('https://cdn.example/a.mp3')).toBe(
      'https://cdn.example/a.mp3',
    )
  })

  it('credentialFingerprint 与路由层 credentialKey 同算法（同输入同指纹）', () => {
    expect(credentialFingerprint(undefined)).toBe('anon')
    expect(credentialFingerprint('')).toBe('anon')
    const a = credentialFingerprint('MUSIC_U=x')
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(a).toBe(credentialFingerprint('MUSIC_U=x'))
    expect(a).not.toBe(credentialFingerprint('MUSIC_U=y'))
  })

  it('sessionCookieHeader 只挑名单内的 cookie，并去掉属性段', () => {
    const cookies = [
      'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com',
      'buvid3=noise; Path=/',
      'bili_jct=tok',
    ]
    expect(sessionCookieHeader(cookies, ['SESSDATA', 'bili_jct'])).toBe(
      'SESSDATA=abc%2Cdef; bili_jct=tok',
    )
    expect(sessionCookieHeader(cookies, [])).toBeUndefined()
    expect(sessionCookieHeader(undefined, ['SESSDATA'])).toBeUndefined()
  })

  it('isTransientError 只把网络错误 / 5xx / 429 视为瞬时故障', () => {
    expect(isTransientError(new UpstreamError(0, 'net'))).toBe(true)
    expect(isTransientError(new UpstreamError(503, '5xx'))).toBe(true)
    expect(isTransientError(new UpstreamError(429, 'limited'))).toBe(true)
    expect(isTransientError(new UpstreamError(412, '风控'))).toBe(false)
    expect(isTransientError(new UpstreamError(404, 'nf'))).toBe(false)
  })

  it('codecName 优先用上游类型，缺失时回退直链后缀', () => {
    expect(codecName('mp3', 'https://x/a.flac')).toBe('MP3')
    expect(codecName(undefined, 'https://x/a.flac?auth=1')).toBe('FLAC')
    expect(codecName('', 'https://x/noext')).toBeUndefined()
  })

  it('makeQuality 丢弃非正数，不臆造缺失字段', () => {
    expect(makeQuality('AAC', 0, -1)).toEqual({
      codec: 'AAC',
      br: undefined,
      sr: undefined,
    })
    expect(makeQuality(undefined, 192000, 44100)).toEqual({
      codec: undefined,
      br: 192000,
      sr: 44100,
    })
  })
})

describe('sources/http upstreamJson 重试分类', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('瞬时故障重试，成功即返回', async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal('fetch', () => {
      n++
      if (n === 1) return Promise.resolve({ ok: false, status: 502 })
      return Promise.resolve(jsonRes({ ok: 1 }))
    })
    const p = upstreamJson<{ ok: number }>('https://x', { attempts: 3 })
    await vi.advanceTimersByTimeAsync(500)
    await expect(p).resolves.toEqual({ ok: 1 })
    expect(n).toBe(2)
  })

  it('4xx 不重试（业务失败交调用方降级，不反复补刀）', async () => {
    let n = 0
    vi.stubGlobal('fetch', () => {
      n++
      return Promise.resolve({ ok: false, status: 403 })
    })
    await expect(
      upstreamJson('https://x', { attempts: 5 }),
    ).rejects.toBeInstanceOf(UpstreamError)
    expect(n).toBe(1)
  })

  it('业务错误码（businessError）同样不由本层重试', async () => {
    expect(businessError(-412, 'bilibili').code).toBe(-412)
    expect(isTransientError(businessError(-412, 'bilibili'))).toBe(false)
  })
})

describe('sources/http parseSampleRate（fMP4 init segment）', () => {
  /** 构造一个最小 `moov/trak/mdia/minf/stbl/stsd` 树，首个 entry 为 mp4a + 16.16 采样率。 */
  function mp4(majorBrand: string, sampleRate: number, entryType = 'mp4a') {
    const box = (type: string, payload: Uint8Array) => {
      const out = new Uint8Array(8 + payload.length)
      const v = new DataView(out.buffer)
      v.setUint32(0, out.length)
      out.set(new TextEncoder().encode(type), 4)
      out.set(payload, 8)
      return out
    }
    // stsd 负载：version/flags(4) + entry_count(4) + entry
    const entry = new Uint8Array(36)
    entry.set(new TextEncoder().encode(entryType), 4)
    // AudioSampleEntry: 从 entry 起始算，box 头 8 + SampleEntry 8 + 保留 8 = 24
    // 偏移处为 16.16 定点采样率
    new DataView(entry.buffer).setUint32(8 + 24, sampleRate << 16)
    const header = new Uint8Array(8)
    new DataView(header.buffer).setUint32(4, 1) // version/flags = 0, entry_count = 1
    const stsd = box('stsd', concat(header, entry))
    const stbl = box('stbl', stsd)
    const minf = box('minf', stbl)
    const mdia = box('mdia', minf)
    const trak = box('trak', mdia)
    const moov = box('moov', trak)
    const ftyp = box('ftyp', new TextEncoder().encode(majorBrand))
    return concat(ftyp, moov)
  }
  const concat = (...arrs: Uint8Array[]) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
    let at = 0
    for (const a of arrs) {
      out.set(a, at)
      at += a.length
    }
    return out
  }

  it('从标准 mp4a sample entry 解出采样率', () => {
    expect(parseSampleRate(mp4('iso5', 44100))).toBe(44100)
    expect(parseSampleRate(mp4('iso5', 48000))).toBe(48000)
  })

  it('非 ISO 音频的 entry 类型或脏数据 → undefined（不抛错）', () => {
    expect(parseSampleRate(mp4('iso5', 44100, 'opus'))).toBeUndefined()
    expect(parseSampleRate(new Uint8Array([0, 0, 0, 0]))).toBeUndefined()
    expect(parseSampleRate(new Uint8Array(0))).toBeUndefined()
  })
})

describe('sources/http upstreamExpiresAt（/stream 下放缓存的寿命依据）', () => {
  const NOW = 1_700_000_000_000
  const res = (headers: Record<string, string>) =>
    new Response(null, { status: 200, headers })

  it('上游未声明寿命 → null（由调用方用自己的 TTL）', () => {
    expect(upstreamExpiresAt(res({}), NOW)).toBeNull()
    expect(
      upstreamExpiresAt(res({ 'cache-control': 'public' }), NOW),
    ).toBeNull()
  })

  it('只认 max-age 与 Expires，并扣掉提前量', () => {
    expect(
      upstreamExpiresAt(res({ 'cache-control': 'public, max-age=600' }), NOW),
    ).toBe(NOW + 600_000 - STREAM_EXPIRY_MARGIN_MS)
    expect(
      upstreamExpiresAt(
        res({ expires: new Date(NOW + 900_000).toUTCString() }),
        NOW,
      ),
    ).toBe(NOW + 900_000 - STREAM_EXPIRY_MARGIN_MS)
  })

  it('两者并存取较早者', () => {
    expect(
      upstreamExpiresAt(
        res({
          'cache-control': 'max-age=1200',
          expires: new Date(NOW + 300_000).toUTCString(),
        }),
        NOW,
      ),
    ).toBe(NOW + 300_000 - STREAM_EXPIRY_MARGIN_MS)
  })

  it('no-store → 立刻到期（不再复用）', () => {
    expect(
      upstreamExpiresAt(res({ 'cache-control': 'no-store, max-age=600' }), NOW),
    ).toBe(NOW)
  })

  it('过期 / 无法解析的 Expires 不算数', () => {
    expect(upstreamExpiresAt(res({ expires: 'not-a-date' }), NOW)).toBeNull()
    expect(
      upstreamExpiresAt(
        res({ expires: new Date(NOW - 10_000).toUTCString() }),
        NOW,
      ),
    ).toBe(NOW - 10_000 - STREAM_EXPIRY_MARGIN_MS)
  })
})
