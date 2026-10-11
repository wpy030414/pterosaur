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
      phase: 'fetch',
      current: 0,
      total: 5,
      percent: null,
    })

    useRip.getState().setProgress(3, 5)
    expect(useRip.getState().job).toEqual({
      key: 'album:1',
      phase: 'fetch',
      current: 3,
      total: 5,
      percent: null,
    })

    useRip.getState().finish()
    expect(useRip.getState().job).toBeNull()
  })

  it('phase / percent 流转（实体刻录链路）', () => {
    useRip.getState().start('favorites', 3)
    useRip.getState().setPhase('convert')
    useRip.getState().setProgress(2, 3)
    expect(useRip.getState().job).toMatchObject({
      phase: 'convert',
      current: 2,
      total: 3,
    })

    useRip.getState().setPhase('burn')
    useRip.getState().setPercent(null)
    expect(useRip.getState().job).toMatchObject({
      phase: 'burn',
      percent: null,
    })
  })

  it('空闲时 setProgress / setPhase / setPercent 为 no-op', () => {
    useRip.getState().setProgress(1, 2)
    useRip.getState().setPhase('burn')
    useRip.getState().setPercent(50)
    expect(useRip.getState().job).toBeNull()
  })
})
