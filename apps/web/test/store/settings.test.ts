import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_AUDIO_LEVEL } from '@pterosaur/shared/types'
import { useSettings } from '../../src/store/settings.js'

describe('useSettings（音质偏好）', () => {
  beforeEach(() => {
    useSettings.setState({ level: DEFAULT_AUDIO_LEVEL })
  })

  it('默认档位为缺省档（exhigh）', () => {
    expect(useSettings.getState().level).toBe(DEFAULT_AUDIO_LEVEL)
  })

  it('setLevel 更新档位', () => {
    useSettings.getState().setLevel('lossless')
    expect(useSettings.getState().level).toBe('lossless')
  })
})
