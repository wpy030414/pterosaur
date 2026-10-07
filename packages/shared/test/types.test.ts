import { describe, it, expect } from 'vitest'
import {
  formatTime,
  streamUrl,
  sourceOf,
  keyOf,
  isMusicSource,
  isCassetteSource,
  formatQuality,
  formatSampleRate,
} from '../src/types.js'
import type { MusicSource } from '../src/types.js'

describe('formatTime', () => {
  it('格式化 0 秒', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  it('秒数补零', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(600)).toBe('10:00')
  })

  it('向下取整', () => {
    expect(formatTime(59.9)).toBe('0:59')
    expect(formatTime(61.7)).toBe('1:01')
  })

  it('满 1 小时换算为 h:mm:ss（分钟 / 秒补零）', () => {
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(7322)).toBe('2:02:02') // 此前为 122:02，不可读
    expect(formatTime(3605.9)).toBe('1:00:05') // 取整同样生效
    expect(formatTime(3599)).toBe('59:59') // 差 1 秒不进位
  })

  it('非法输入回退为 0:00', () => {
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(-1)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('streamUrl', () => {
  it('基础路径带源段', () => {
    expect(streamUrl('netease', '123')).toBe('/stream/netease/123')
  })

  it('编码特殊字符 ID', () => {
    expect(streamUrl('netease', 'a/b')).toBe('/stream/netease/a%2Fb')
  })

  it('附带 level 参数', () => {
    expect(streamUrl('netease', '123', { level: 'lossless' })).toBe(
      '/stream/netease/123?level=lossless',
    )
  })

  it('附带 token 参数', () => {
    const url = streamUrl('netease', '123', { level: 'exhigh', token: 'abc' })
    expect(url).toContain('level=exhigh')
    expect(url).toContain('t=abc')
  })
})

describe('sourceOf / keyOf', () => {
  it('缺失 source 时回填缺省源（旧数据兼容）', () => {
    const legacy = { id: '1' } as { id: string; source?: MusicSource }
    expect(sourceOf(legacy)).toBe('netease')
    expect(keyOf(legacy)).toBe('netease:1')
  })

  it('身份键 = `<source>:<id>`', () => {
    expect(keyOf({ source: 'netease', id: '1' })).toBe('netease:1')
  })
})

describe('isMusicSource', () => {
  it('识别合法音源', () => {
    expect(isMusicSource('netease')).toBe(true)
    expect(isMusicSource('bilibili')).toBe(true) // 磁带渠道也是合法源
  })

  it('拒绝非法值与本地歌单前缀', () => {
    expect(isMusicSource('pl-abc')).toBe(false)
    expect(isMusicSource('spotify')).toBe(false)
    expect(isMusicSource(undefined)).toBe(false)
  })
})

describe('isCassetteSource', () => {
  it('仅磁带渠道为真', () => {
    expect(isCassetteSource('bilibili')).toBe(true)
    expect(isCassetteSource('netease')).toBe(false)
    expect(isCassetteSource(undefined)).toBe(false)
  })
})

describe('formatSampleRate', () => {
  it('整千 Hz 显示为整数 kHz', () => {
    expect(formatSampleRate(48000)).toBe('48kHz')
    expect(formatSampleRate(96000)).toBe('96kHz')
    expect(formatSampleRate(8000)).toBe('8kHz')
  })

  it('非整千保留一位小数', () => {
    expect(formatSampleRate(44100)).toBe('44.1kHz')
    expect(formatSampleRate(22050)).toBe('22.1kHz')
  })
})

describe('formatQuality', () => {
  it('拼接编解码 / 码率 / 采样率', () => {
    expect(formatQuality({ codec: 'flac', br: 1411000, sr: 44100 })).toBe(
      'FLAC · 1411Kbps · 44.1kHz',
    )
    expect(formatQuality({ codec: 'mp3', br: 320000, sr: 44100 })).toBe(
      'MP3 · 320Kbps · 44.1kHz',
    )
    // B 站实测码率非整 Kbps，四舍五入
    expect(formatQuality({ codec: 'AAC', br: 204800 })).toBe('AAC · 205Kbps')
  })

  it('缺失字段按需省略', () => {
    expect(formatQuality({ br: 320000 })).toBe('320Kbps')
    expect(formatQuality({ codec: 'FLAC' })).toBe('FLAC')
    expect(formatQuality({})).toBe('')
  })
})
