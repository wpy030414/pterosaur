import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { downloadPlaylist } from '../../src/lib/downloadPlaylist.js'
import type { RipMetaInput } from '@pterosaur/shared/rip'
import type { Track } from '@pterosaur/shared/types'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

import { saveAs } from 'file-saver'

const track = (over: Partial<Track> = {}): Track => ({
  source: 'netease',
  id: '1',
  title: '曲目一',
  artist: '艺术家',
  album: '专辑',
  cover: 'https://p3.music.126.net/x.jpg',
  duration: 200,
  fee: 'free',
  ...over,
})

const metaInput: RipMetaInput = {
  distribution: 'digital',
  kind: 'playlist',
  name: '测试歌单',
  source: 'netease',
  sourceId: '42',
  level: 'exhigh',
}

/** 假响应：具备 downloadPlaylist 实际用到的字段（ok/status/headers/blob）。 */
const fakeRes = (ok: boolean, contentType: string | null) => ({
  ok,
  status: ok ? 200 : 403,
  headers: {
    get: (k: string) =>
      k.toLowerCase() === 'content-type' ? contentType : null,
  },
  blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
})

/** 假 fetch：`/stream` 按 id 返回音频（id 含 `bad` 的曲目回 403），封面 URL 返回 png。 */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('/cover')) return fakeRes(true, 'image/png')
      if (url.includes('bad')) return fakeRes(false, null)
      return fakeRes(true, 'audio/flac')
    }),
  )
}

beforeEach(() => {
  vi.mocked(saveAs).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('downloadPlaylist 打包（含 meta.json）', () => {
  it('写入 meta.json：逐曲文件名回填、封面引用、跳过清单', async () => {
    stubFetch()
    const tracks = [
      track({ id: 'a' }),
      track({ id: 'bad', title: '坏曲' }),
      track({ id: 'c', duration: 100 }),
    ]
    const events: string[] = []
    await downloadPlaylist(
      tracks,
      '测试歌单',
      (p) =>
        events.push(
          `${p.current}/${p.total}${p.lastError ? `!${p.lastError}` : ''}`,
        ),
      'https://p3.music.126.net/cover.jpg',
      'exhigh',
      { metaInput },
    )

    expect(saveAs).toHaveBeenCalledTimes(1)
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0]
    expect(filename).toBe('测试歌单.zip')

    const zip = await JSZip.loadAsync(blob as Blob)
    expect(zip.file('cover.png')).toBeTruthy()
    expect(zip.file('1 - 曲目一.flac')).toBeTruthy()
    expect(zip.file('3 - 曲目一.flac')).toBeTruthy()
    expect(zip.file('2 - 坏曲.flac')).toBeNull()

    const meta = JSON.parse(await zip.file('meta.json')!.async('string'))
    expect(meta.schema).toBe('pterosaur-rip@1')
    expect(meta.kind).toBe('playlist')
    expect(meta.trackCount).toBe(3)
    expect(meta.tracks[0].file).toBe('1 - 曲目一.flac')
    expect(meta.tracks[1].file).toBeUndefined()
    expect(meta.tracks[2].file).toBe('3 - 曲目一.flac')
    expect(meta.cover).toEqual({
      file: 'cover.png',
      url: 'https://p3.music.126.net/cover.jpg',
    })
    expect(meta.skipped).toHaveLength(1)
    expect(meta.skipped[0]).toMatchObject({
      index: 2,
      title: '坏曲',
      reason: 'HTTP 403',
    })

    // 进度回调：第 2 首带失败信息，其余为 null
    expect(events).toEqual(['1/3', '2/3!坏曲: HTTP 403', '3/3'])
  })

  it('缺省 metaInput：不写 meta.json（与旧版行为一致）', async () => {
    stubFetch()
    await downloadPlaylist([track({ id: 'a' })], '无元信息')
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0]
    expect(filename).toBe('无元信息.zip')
    const zip = await JSZip.loadAsync(blob as Blob)
    expect(zip.file('meta.json')).toBeNull()
    expect(zip.file('1 - 曲目一.flac')).toBeTruthy()
  })
})
