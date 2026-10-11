import { describe, it, expect } from 'vitest'
import {
  AUDIO_CD_MAX_SECONDS,
  RIP_META_SCHEMA,
  audioCdFits,
  audioCdFitsTotal,
  buildRipMeta,
  extFromImageMime,
  extFromMime,
  isLoopbackHost,
  ripFileName,
  safeRipName,
} from '../src/rip.js'
import type { RipMetaInput } from '../src/rip.js'
import type { Track } from '../src/types.js'

const track = (over: Partial<Track> = {}): Track => ({
  source: 'netease',
  id: '1',
  title: '曲目',
  artist: '艺人',
  album: '专辑',
  cover: 'https://p3.music.126.net/x.jpg',
  duration: 200,
  fee: 'free',
  ...over,
})

const input = (over: Partial<RipMetaInput> = {}): RipMetaInput => ({
  distribution: 'digital',
  kind: 'playlist',
  name: '测试歌单',
  source: 'netease',
  sourceId: '42',
  level: 'exhigh',
  ...over,
})

describe('buildRipMeta', () => {
  it('基础字段与 1 起序号', () => {
    const meta = buildRipMeta(
      input(),
      [track({ id: 'a' }), track({ id: 'b', duration: 100 })],
      { generatedAt: '2026-01-02T03:04:05.000Z' },
    )
    expect(meta.schema).toBe(RIP_META_SCHEMA)
    expect(meta.generatedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(meta.kind).toBe('playlist')
    expect(meta.name).toBe('测试歌单')
    expect(meta.source).toBe('netease')
    expect(meta.sourceId).toBe('42')
    expect(meta.trackCount).toBe(2)
    expect(meta.totalDuration).toBe(300)
    expect(meta.level).toBe('exhigh')
    expect(meta.tracks.map((t) => t.index)).toEqual([1, 2])
    expect(meta.tracks[0].id).toBe('a')
  })

  it('fileOf 回填文件名；缺省时 file 为 undefined（音频 CD 无文件）', () => {
    const withFile = buildRipMeta(input(), [track()], {
      fileOf: (i) => `0${i} - x.flac`,
    })
    expect(withFile.tracks[0].file).toBe('01 - x.flac')

    const noFile = buildRipMeta(input({ distribution: 'physical' }), [track()])
    expect(noFile.tracks[0].file).toBeUndefined()
  })

  it('cover 需 coverUrl 与 coverFile 同时具备', () => {
    const both = buildRipMeta(
      input({ coverUrl: 'https://p3.music.126.net/c.jpg' }),
      [track()],
      {
        coverFile: 'cover.jpg',
      },
    )
    expect(both.cover).toEqual({
      file: 'cover.jpg',
      url: 'https://p3.music.126.net/c.jpg',
    })
    expect(
      buildRipMeta(input({ coverUrl: 'https://x/c.jpg' }), [track()]).cover,
    ).toBeUndefined()
    expect(
      buildRipMeta(input(), [track()], { coverFile: 'cover.jpg' }).cover,
    ).toBeUndefined()
  })

  it('skipped 仅在非空时携带', () => {
    expect(buildRipMeta(input(), [track()]).skipped).toBeUndefined()
    expect(
      buildRipMeta(input(), [track()], { skipped: [] }).skipped,
    ).toBeUndefined()
    const meta = buildRipMeta(input(), [track()], {
      skipped: [{ index: 1, title: 'x', reason: 'HTTP 403' }],
    })
    expect(meta.skipped).toEqual([{ index: 1, title: 'x', reason: 'HTTP 403' }])
  })

  it('实体分发携带 discType', () => {
    const meta = buildRipMeta(
      input({ distribution: 'physical', discType: 'audio' }),
      [track()],
    )
    expect(meta.distribution).toBe('physical')
    expect(meta.discType).toBe('audio')
  })
})

describe('safeRipName', () => {
  it('非法字符替换为下划线', () => {
    expect(safeRipName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('控制字符移除、空白折叠、首尾修剪', () => {
    expect(safeRipName('  a\u0000  b  c\u001f ')).toBe('a b c')
  })

  it('空 / 全非法回退 track', () => {
    expect(safeRipName('')).toBe('track')
    expect(safeRipName('   ')).toBe('track')
    expect(safeRipName('...')).toBe('track')
  })

  it('超长按码点截断到 80', () => {
    const long = '喵'.repeat(200)
    expect([...safeRipName(long)].length).toBe(80)
  })

  it('去尾部点与空格（Windows 文件名合法化）', () => {
    expect(safeRipName('歌名. .')).toBe('歌名')
  })
})

describe('ripFileName', () => {
  it('序号按总曲数补零，字典序即曲序', () => {
    expect(ripFileName(1, 12, '曲名', 'flac')).toBe('01 - 曲名.flac')
    expect(ripFileName(10, 12, '曲名', 'mp3')).toBe('10 - 曲名.mp3')
    expect(ripFileName(1, 100, '曲名', 'mp3')).toBe('001 - 曲名.mp3')
    expect(ripFileName(3, 5, 'a/b', 'mp3')).toBe('3 - a_b.mp3')
  })
})

describe('extFromMime / extFromImageMime', () => {
  it('音频扩展名', () => {
    expect(extFromMime(null)).toBe('mp3')
    expect(extFromMime('audio/mpeg')).toBe('mp3')
    expect(extFromMime('audio/flac')).toBe('flac')
    expect(extFromMime('audio/mp4')).toBe('m4a')
    expect(extFromMime('audio/wav')).toBe('wav')
  })

  it('图片扩展名', () => {
    expect(extFromImageMime(null)).toBe('jpg')
    expect(extFromImageMime('image/png')).toBe('png')
    expect(extFromImageMime('image/webp')).toBe('webp')
    expect(extFromImageMime('image/avif')).toBe('avif')
    expect(extFromImageMime('image/jpeg')).toBe('jpg')
  })
})

describe('audioCdFits', () => {
  it('计入每轨 2s gap 的边界', () => {
    // 单轨：4738 + 2 = 4740 恰好通过；4739 + 2 = 4741 拒绝
    expect(audioCdFits([AUDIO_CD_MAX_SECONDS - 2])).toBe(true)
    expect(audioCdFits([AUDIO_CD_MAX_SECONDS - 1])).toBe(false)
  })

  it('多轨 gap 累加', () => {
    // 两轨 2368s：4736 + 4 = 4740 通过；2369s：4738 + 4 = 4742 拒绝
    expect(audioCdFits([2368, 2368])).toBe(true)
    expect(audioCdFits([2369, 2369])).toBe(false)
  })

  it('非法时长按 0 计', () => {
    expect(audioCdFits([NaN, 100])).toBe(true)
    expect(audioCdFits([-5, 100])).toBe(true)
  })

  it('audioCdFitsTotal 与 audioCdFits 同口径', () => {
    expect(audioCdFitsTotal(4736, 2)).toBe(true) // 4736 + 2×2 = 4740
    expect(audioCdFitsTotal(4737, 2)).toBe(false)
    expect(audioCdFitsTotal(NaN, 3)).toBe(true)
    expect(audioCdFitsTotal(4740, 0)).toBe(true)
  })
})

describe('isLoopbackHost', () => {
  it('回环地址族全部接受', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.8.8.8',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(h), h).toBe(true)
    }
  })

  it('非回环一律拒绝', () => {
    for (const h of [
      '192.168.1.2',
      '10.0.0.5',
      'localhost.evil.com',
      '::ffff:192.168.1.2',
      '127.0.0.1.evil.com',
      '',
    ]) {
      expect(isLoopbackHost(h), h).toBe(false)
    }
  })
})
