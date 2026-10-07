import { beforeEach, describe, expect, it } from 'vitest'
import { useRip } from '../../src/store/rip.js'

beforeEach(() => {
  useRip.setState({ job: null })
})

describe('rip store 生命周期', () => {
  it('start → setProgress → finish', () => {
    useRip.getState().start('album:1', 5)
    expect(useRip.getState().job).toEqual({
      key: 'album:1',
      current: 0,
      total: 5,
    })

    useRip.getState().setProgress(3, 5)
    expect(useRip.getState().job).toEqual({
      key: 'album:1',
      current: 3,
      total: 5,
    })

    useRip.getState().finish()
    expect(useRip.getState().job).toBeNull()
  })

  it('空闲时 setProgress 为 no-op', () => {
    useRip.getState().setProgress(1, 2)
    expect(useRip.getState().job).toBeNull()
  })
})
