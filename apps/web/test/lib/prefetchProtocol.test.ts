import { describe, it, expect } from 'vitest'
import { DEFAULT_AUDIO_LEVEL } from '@pterosaur/shared/types'
import {
  PREFETCH_AUDIO,
  parsePrefetchAudio,
  prefetchAudioMessage,
} from '../../src/lib/prefetchProtocol.js'
import { audioKey } from '../../src/lib/mediaCache.js'

describe('prefetchAudioMessage（页面侧构造）', () => {
  it('产出带 type/source/id/level 的消息', () => {
    expect(
      prefetchAudioMessage({ source: 'netease', id: '9' }, 'lossless'),
    ).toEqual({
      type: PREFETCH_AUDIO,
      source: 'netease',
      id: '9',
      level: 'lossless',
    })
  })
})

describe('parsePrefetchAudio（SW 侧校验）', () => {
  it('合法消息 → 解析出 source/id/level/key（key 与 audioKey 同源）', () => {
    const r = parsePrefetchAudio({
      type: PREFETCH_AUDIO,
      source: 'netease',
      id: '9',
      level: 'lossless',
    })
    expect(r).toEqual({
      source: 'netease',
      id: '9',
      level: 'lossless',
      key: audioKey('netease', '9', 'lossless'),
    })
  })

  it('level 缺失或非法 → 归一为缺省档', () => {
    expect(
      parsePrefetchAudio({ type: PREFETCH_AUDIO, source: 'netease', id: '9' })
        ?.level,
    ).toBe(DEFAULT_AUDIO_LEVEL)
    expect(
      parsePrefetchAudio({
        type: PREFETCH_AUDIO,
        source: 'netease',
        id: '9',
        level: 'bogus',
      })?.level,
    ).toBe(DEFAULT_AUDIO_LEVEL)
  })

  it('非法输入一律返回 null', () => {
    expect(
      parsePrefetchAudio({ type: PREFETCH_AUDIO, source: 'qq', id: '9' }),
    ).toBeNull()
    expect(
      parsePrefetchAudio({ type: PREFETCH_AUDIO, source: 'netease', id: '' }),
    ).toBeNull()
    expect(
      parsePrefetchAudio({ type: PREFETCH_AUDIO, source: 'netease' }),
    ).toBeNull()
    expect(
      parsePrefetchAudio({ type: 'OTHER', source: 'netease', id: '9' }),
    ).toBeNull()
    expect(parsePrefetchAudio({})).toBeNull()
    expect(parsePrefetchAudio(null)).toBeNull()
    expect(parsePrefetchAudio('PREFETCH_AUDIO')).toBeNull()
    expect(parsePrefetchAudio(42)).toBeNull()
  })
})
