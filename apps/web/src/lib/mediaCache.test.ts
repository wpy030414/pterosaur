import { beforeEach, describe, expect, it } from 'vitest'
import {
  type MediaMeta,
  CAP_BYTES,
  IMAGE_TTL_MS,
  audioKey,
  clearMediaCache,
  effectiveCap,
  expiredKeys,
  imageKey,
  isExpired,
  isWholeFileRange,
  isWholeFileResponse,
  mediaUsage,
  parseRange,
  pickEvictions,
  putCached,
  responseFromBlob,
} from './mediaCache.js'

const meta = (key: string, size: number, lastAccess: number): MediaMeta => ({
  key,
  kind: 'audio',
  trackId: key,
  mime: 'audio/mpeg',
  size,
  lastAccess,
})

const blobOf = (size: number): Blob => new Blob([new Uint8Array(size)])

describe('audioKey', () => {
  it('带源前缀与默认档位 exhigh', () => {
    expect(audioKey('netease', '123')).toBe('netease:123|exhigh')
    expect(audioKey('netease', '123', 'lossless')).toBe('netease:123|lossless')
  })

  it('不同档位产生不同缓存键', () => {
    expect(audioKey('netease', '1')).not.toBe(
      audioKey('netease', '1', 'lossless'),
    )
  })
})

describe('imageKey', () => {
  it('前缀区分封面并保留完整（含 param 的）地址；非网易云地址原样', () => {
    expect(imageKey('https://cdn.example.com/a.jpg?param=600y600')).toBe(
      'image|https://cdn.example.com/a.jpg?param=600y600',
    )
    expect(imageKey(new URL('https://cdn.example.com/a.jpg'))).toBe(
      'image|https://cdn.example.com/a.jpg',
    )
  })

  it('网易云镜像主机轮换（p1/p4）与 http 均规范化为同一 key（ADR-020）', () => {
    expect(imageKey('https://p1.music.126.net/h==/1.jpg?param=600y600')).toBe(
      'image|https://p3.music.126.net/h==/1.jpg?param=600y600',
    )
    expect(imageKey('http://p4.music.126.net/h==/1.jpg?param=600y600')).toBe(
      'image|https://p3.music.126.net/h==/1.jpg?param=600y600',
    )
  })

  it('不同 param 尺寸仍各占一条（同图不同字节）', () => {
    expect(
      imageKey('https://p1.music.126.net/h==/1.jpg?param=300y300'),
    ).not.toBe(imageKey('https://p2.music.126.net/h==/1.jpg?param=600y600'))
  })
})

describe('isExpired / expiredKeys', () => {
  const image = (key: string, cachedAt?: number): MediaMeta => ({
    key,
    kind: 'image',
    mime: 'image/jpeg',
    size: 10,
    lastAccess: 0,
    cachedAt,
  })

  it('音频不受限时过期约束', () => {
    const now = Date.now()
    expect(isExpired(meta('a', 10, 0), now)).toBe(false)
    // 即便带一个很旧的 cachedAt，音频也不过期
    expect(isExpired({ ...meta('a', 10, 0), cachedAt: 0 }, now)).toBe(false)
  })

  it('封面未满 7 天不过期，满 7 天（含边界）过期', () => {
    const now = 1_000_000_000_000
    expect(isExpired(image('image|x', now - (IMAGE_TTL_MS - 1)), now)).toBe(
      false,
    )
    expect(isExpired(image('image|x', now - IMAGE_TTL_MS), now)).toBe(true)
    expect(isExpired(image('image|x', now - IMAGE_TTL_MS - 1), now)).toBe(true)
  })

  it('缺 cachedAt 的旧封面视作很久以前 → 过期', () => {
    expect(isExpired(image('image|x'), Date.now())).toBe(true)
  })

  it('expiredKeys 只挑出过期的封面', () => {
    const now = 1_000_000_000_000
    const metas: MediaMeta[] = [
      { ...meta('123|exhigh', 100, 0), cachedAt: 0 }, // 音频：永不过期
      image('image|fresh', now - 1000), // 新鲜封面
      image('image|stale', now - IMAGE_TTL_MS), // 过期封面
    ]
    expect(expiredKeys(metas, now)).toEqual(['image|stale'])
  })
})

describe('effectiveCap', () => {
  it('无配额信息时使用 16GB', () => {
    expect(effectiveCap(null)).toBe(CAP_BYTES)
    expect(effectiveCap(undefined)).toBe(CAP_BYTES)
  })

  it('配额较小则按安全系数取配额', () => {
    const quota = 10 * 1024 ** 3
    expect(effectiveCap(quota)).toBe(Math.floor(quota * 0.9))
  })

  it('配额充足则封顶 16GB', () => {
    expect(effectiveCap(100 * 1024 ** 3)).toBe(CAP_BYTES)
  })
})

describe('isWholeFileRange', () => {
  it('无 Range 与 bytes=0- 前缀视为整文件请求', () => {
    expect(isWholeFileRange(null)).toBe(true)
    expect(isWholeFileRange('bytes=0-')).toBe(true)
    expect(isWholeFileRange(' bytes=0- ')).toBe(true)
    expect(isWholeFileRange('bytes=0-1')).toBe(true)
    expect(isWholeFileRange('bytes=0-999')).toBe(true)
  })

  it('起点 > 0 与后缀 Range 不视为整文件', () => {
    expect(isWholeFileRange('bytes=100-')).toBe(false)
    expect(isWholeFileRange('bytes=100-999')).toBe(false)
    expect(isWholeFileRange('bytes=-500')).toBe(false)
    expect(isWholeFileRange('nonsense')).toBe(false)
  })
})

describe('isWholeFileResponse', () => {
  it('200（无 Content-Range）视为整文件响应', () => {
    expect(isWholeFileResponse(200, null)).toBe(true)
  })

  it('206 且 Content-Range 为 0-总长 端点 视为整文件响应（部分 CDN 如此回全量）', () => {
    expect(isWholeFileResponse(206, 'bytes 0-10437164/10437165')).toBe(true)
    expect(isWholeFileResponse(206, 'bytes 0-99/100')).toBe(true)
  })

  it('切片 206、非 0 起点与非法输入不视为整文件响应', () => {
    expect(isWholeFileResponse(206, 'bytes 0-99/200')).toBe(false)
    expect(isWholeFileResponse(206, 'bytes 131072-10437164/10437165')).toBe(
      false,
    )
    expect(isWholeFileResponse(206, null)).toBe(false)
    expect(isWholeFileResponse(403, null)).toBe(false)
  })
})

describe('parseRange', () => {
  it('bytes=0- → 整个区间', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
  })

  it('bytes=10-19 → 精确区间', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('bytes=-10 → 末尾 10 字节', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('末端越界被裁剪到 size-1', () => {
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
  })

  it('非法或不可满足返回 null', () => {
    expect(parseRange('nonsense', 100)).toBeNull()
    expect(parseRange('bytes=100-', 100)).toBeNull()
    expect(parseRange('bytes=50-10', 100)).toBeNull()
  })
})

describe('pickEvictions', () => {
  const metas = [meta('a', 100, 1), meta('b', 200, 2), meta('c', 300, 3)]

  it('容量充足时不淘汰', () => {
    expect(pickEvictions(metas, 1000, 100)).toEqual([])
  })

  it('按 lastAccess 升序淘汰至可容纳', () => {
    // total 600 + 200 = 800 > 500；淘汰 a(100)→700，b(200)→500 ≤ 500 停止
    expect(pickEvictions(metas, 500, 200)).toEqual(['a', 'b'])
  })

  it('音频与封面在同一预算内跨类别淘汰', () => {
    const mixed: MediaMeta[] = [
      { ...meta('audio|1', 100, 2), kind: 'audio' },
      {
        key: 'image|x',
        kind: 'image',
        mime: 'image/jpeg',
        size: 400,
        lastAccess: 1,
      },
    ]
    // total 500 + 300 = 800 > 600；先淘汰最久未用的封面(image|x, 400) → 400 ≤ 600 停止
    expect(pickEvictions(mixed, 600, 300)).toEqual(['image|x'])
  })
})

describe('responseFromBlob', () => {
  it('无 Range → 200 全量', () => {
    const res = responseFromBlob(meta('x', 10, 0), blobOf(10), null)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  it('有 Range → 206 切片与 Content-Range', () => {
    const res = responseFromBlob(meta('x', 10, 0), blobOf(10), 'bytes=2-4')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(res.headers.get('content-length')).toBe('3')
  })
})

describe('mediaUsage / clearMediaCache', () => {
  beforeEach(() => clearMediaCache())

  it('按类别分项统计', async () => {
    await putCached(
      { ...meta('123|exhigh', 100, 1), level: 'exhigh' },
      blobOf(100),
    )
    await putCached(
      {
        key: 'image|x',
        kind: 'image',
        mime: 'image/jpeg',
        size: 40,
        lastAccess: 1,
      },
      blobOf(40),
    )

    const usage = await mediaUsage()
    expect(usage).toEqual({
      count: 2,
      bytes: 140,
      audioBytes: 100,
      imageBytes: 40,
    })

    await clearMediaCache()
    expect(await mediaUsage()).toEqual({
      count: 0,
      bytes: 0,
      audioBytes: 0,
      imageBytes: 0,
    })
  })
})
