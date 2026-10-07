import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_AUDIO_LEVEL } from '@pterosaur/shared/types'
import { useSettings } from '../../src/store/settings.js'

describe('useSettings（音质 + 背景偏好）', () => {
  beforeEach(() => {
    useSettings.setState({ level: DEFAULT_AUDIO_LEVEL, background: null })
  })

  it('默认档位为缺省档（exhigh）', () => {
    expect(useSettings.getState().level).toBe(DEFAULT_AUDIO_LEVEL)
  })

  it('setLevel 更新档位', () => {
    useSettings.getState().setLevel('lossless')
    expect(useSettings.getState().level).toBe('lossless')
  })

  it('默认无自定义背景', () => {
    expect(useSettings.getState().background).toBeNull()
  })

  it('setBackground 更新 / 清除背景', () => {
    useSettings.getState().setBackground({
      kind: 'image',
      mime: 'image/png',
      accent: '#336699',
    })
    expect(useSettings.getState().background?.accent).toBe('#336699')

    useSettings.getState().setBackground(null)
    expect(useSettings.getState().background).toBeNull()
  })
})
