import { beforeEach, describe, expect, it } from 'vitest'
import {
  CAP_BYTES,
  audioKey,
  clearOfflineAudio,
  effectiveCap,
  getAllMeta,
  hasSavedAudio,
  isWholeFileResponse,
  listSaved,
  offlineUsage,
  pickEvictions,
  removeSaved,
  saveAudio,
  touchSaved,
} from '../../src/lib/mediaCache.js'

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

describe('pickEvictions', () => {
  const saved = (key: string, size: number, lastAccess: number) => ({
    key,
    source: 'netease' as const,
    trackId: key,
    level: 'exhigh',
    mime: 'audio/mpeg',
    size,
    lastAccess,
  })
  const metas = [saved('a', 100, 1), saved('b', 200, 2), saved('c', 300, 3)]

  it('容量充足时不淘汰', () => {
    expect(pickEvictions(metas, 1000, 100)).toEqual([])
  })

  it('按 lastAccess 升序淘汰至可容纳', () => {
    // total 600 + 200 = 800 > 500；淘汰 a(100)→700，b(200)→500 ≤ 500 停止
    expect(pickEvictions(metas, 500, 200)).toEqual(['a', 'b'])
  })
})

describe('离线保存（IndexedDB）', () => {
  beforeEach(() => clearOfflineAudio())

  it('saveAudio 后可读回，hasSavedAudio 据元数据判定', async () => {
    await saveAudio('netease', '1', 'exhigh', blobOf(100), 'audio/mpeg')

    expect(await hasSavedAudio('netease', '1')).toBe(true)
    expect(await hasSavedAudio('netease', '1', 'lossless')).toBe(false)
    expect(await hasSavedAudio('bilibili', '1')).toBe(false)
  })

  it('listSaved 按最近访问降序，并补全元数据', async () => {
    await saveAudio(
      'netease',
      'old',
      'exhigh',
      blobOf(10),
      'audio/mpeg',
      'auto',
      1000,
    )
    await saveAudio(
      'netease',
      'new',
      'exhigh',
      blobOf(10),
      'audio/mpeg',
      'auto',
      2000,
    )

    const list = await listSaved()
    expect(list.map((e) => e.trackId)).toEqual(['new', 'old'])
    expect(list[0]).toMatchObject({
      source: 'netease',
      level: 'exhigh',
      mime: 'audio/mpeg',
      size: 10,
    })
  })

  it('touchSaved 刷新最近访问，使 LRU 顺序变化', async () => {
    await saveAudio(
      'netease',
      'a',
      'exhigh',
      blobOf(10),
      'audio/mpeg',
      'auto',
      1000,
    )
    await saveAudio(
      'netease',
      'b',
      'exhigh',
      blobOf(10),
      'audio/mpeg',
      'auto',
      2000,
    )
    await touchSaved(audioKey('netease', 'a'), 3000)

    expect((await listSaved()).map((e) => e.trackId)).toEqual(['a', 'b'])
  })

  it('removeSaved 同时删除 blob 与元数据', async () => {
    await saveAudio('netease', 'x', 'exhigh', blobOf(10), 'audio/mpeg')
    await removeSaved([audioKey('netease', 'x')])

    expect(await hasSavedAudio('netease', 'x')).toBe(false)
    expect(await getAllMeta()).toEqual([])
  })

  it('offlineUsage 统计条数与字节', async () => {
    await saveAudio('netease', 'a', 'exhigh', blobOf(100), 'audio/mpeg')
    await saveAudio('netease', 'b', 'exhigh', blobOf(40), 'audio/mpeg')

    expect(await offlineUsage()).toEqual({ count: 2, bytes: 140 })

    await clearOfflineAudio()
    expect(await offlineUsage()).toEqual({ count: 0, bytes: 0 })
  })
})
