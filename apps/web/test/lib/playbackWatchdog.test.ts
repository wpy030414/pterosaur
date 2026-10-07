import { describe, it, expect } from 'vitest'
import {
  createWatchdog,
  isPrematureEnd,
  DEFAULT_WATCHDOG_CONFIG,
  HAVE_FUTURE_DATA,
  type PlaybackSnapshot,
} from '../../src/lib/playbackWatchdog.js'

/** 构造「播放中」快照；默认 readyState 就绪。 */
const playing = (
  currentTime: number,
  readyState = HAVE_FUTURE_DATA,
): PlaybackSnapshot => ({
  paused: false,
  currentTime,
  readyState,
})

describe('isPrematureEnd（截断流导致的提前结束判定）', () => {
  it('audio 时长显著短于元数据 → 判为截断', () => {
    expect(isPrematureEnd(60, 200)).toBe(true)
    expect(isPrematureEnd(48, 60)).toBe(true)
  })

  it('时长接近或有小偏差 → 不判（避免 VBR 估算误差误判）', () => {
    expect(isPrematureEnd(198, 200)).toBe(false)
    expect(isPrematureEnd(195, 200)).toBe(false) // 差 5s，未达绝对阈值
    expect(isPrematureEnd(85, 90)).toBe(false) // 差 5s
    expect(isPrematureEnd(54, 60)).toBe(false) // 差 6s，未达 10s
  })

  it('元数据或 audio 时长缺失/非法 → 不判（不干预正常流程）', () => {
    expect(isPrematureEnd(30, undefined)).toBe(false)
    expect(isPrematureEnd(30, 0)).toBe(false)
    expect(isPrematureEnd(Number.NaN, 200)).toBe(false)
    expect(isPrematureEnd(0, 200)).toBe(false)
    expect(isPrematureEnd(Number.POSITIVE_INFINITY, 200)).toBe(false)
  })
})

describe('createWatchdog（停滞看门狗）', () => {
  it('暂停期间恒为 none 且不计数', () => {
    const w = createWatchdog()
    expect(w.tick(0, { paused: true, currentTime: 10, readyState: 0 })).toBe(
      'none',
    )
    expect(
      w.tick(100_000, { paused: true, currentTime: 10, readyState: 0 }),
    ).toBe('none')
    expect(w.retries()).toBe(0)
  })

  it('正常前进（就绪或时间推进）不触发恢复', () => {
    const w = createWatchdog()
    expect(w.tick(0, playing(10))).toBe('none')
    expect(w.tick(1000, playing(11))).toBe('none')
    // readyState 不足但时间在前进：仍视为有进展
    expect(w.tick(2000, playing(12, 2))).toBe('none')
    expect(w.retries()).toBe(0)
  })

  it('尚未起播（位置为 0）时不介入，交由起播超时兜底', () => {
    const w = createWatchdog({
      stallMs: 5000,
      maxRetries: 3,
      backoffMs: [10_000],
    })
    expect(w.tick(0, playing(0, 0))).toBe('none')
    expect(w.tick(60_000, playing(0, 0))).toBe('none')
    expect(w.retries()).toBe(0)
  })

  it('停滞达到阈值后触发恢复，并遵守递增退避与次数上限', () => {
    const w = createWatchdog({
      stallMs: 5000,
      maxRetries: 3,
      backoffMs: [10_000, 15_000, 20_000],
    })
    expect(w.tick(0, playing(30, 2))).toBe('none') // 初始化
    expect(w.tick(4000, playing(30, 2))).toBe('none') // 未达 5s
    expect(w.tick(5000, playing(30, 2))).toBe('recover') // 首次恢复
    // 退避期内不再恢复
    expect(w.tick(9000, playing(30, 2))).toBe('none')
    expect(w.tick(10_000, playing(30, 2))).toBe('none')
    expect(w.tick(15_000, playing(30, 2))).toBe('recover') // 第二次（退避 10s）
    expect(w.tick(30_000, playing(30, 2))).toBe('recover') // 第三次（退避 15s）
    expect(w.tick(50_000, playing(30, 2))).toBe('giveUp') // 达上限（退避 20s）
    expect(w.retries()).toBe(3)
  })

  it('恢复成功后计数清零（位置显著超过恢复点）', () => {
    const w = createWatchdog({
      stallMs: 5000,
      maxRetries: 3,
      backoffMs: [10_000],
    })
    expect(w.tick(0, playing(30, 2))).toBe('none')
    expect(w.tick(5000, playing(30, 2))).toBe('recover')
    expect(w.retries()).toBe(1)
    expect(w.tick(6000, playing(32, 4))).toBe('none') // 前进 2s（> 1s）
    expect(w.retries()).toBe(0)
  })

  it('暂停会复位恢复预算', () => {
    const w = createWatchdog({
      stallMs: 5000,
      maxRetries: 3,
      backoffMs: [10_000],
    })
    expect(w.tick(0, playing(30, 2))).toBe('none')
    expect(w.tick(5000, playing(30, 2))).toBe('recover')
    expect(w.retries()).toBe(1)
    w.tick(6000, { paused: true, currentTime: 30, readyState: 0 })
    expect(w.retries()).toBe(0)
  })

  it('noteInterrupt 在预算内允许恢复，超限后拒绝', () => {
    const w = createWatchdog({
      stallMs: 5000,
      maxRetries: 3,
      backoffMs: [10_000],
    })
    expect(w.noteInterrupt(0)).toBe(true)
    expect(w.noteInterrupt(0)).toBe(true)
    expect(w.noteInterrupt(0)).toBe(true)
    expect(w.noteInterrupt(0)).toBe(false)
    expect(w.retries()).toBe(3)
  })

  it('默认退避（所有音源统一）：3 次、10/15/20 秒递增', () => {
    expect(DEFAULT_WATCHDOG_CONFIG.maxRetries).toBe(3)
    expect(DEFAULT_WATCHDOG_CONFIG.backoffMs).toEqual([10_000, 15_000, 20_000])
  })

  it('reset 清空全部状态', () => {
    const w = createWatchdog()
    w.noteInterrupt(0)
    expect(w.retries()).toBe(1)
    w.reset()
    expect(w.retries()).toBe(0)
    // 重置后首帧重新初始化，不会立即误判停滞
    expect(w.tick(1_000_000, playing(30, 2))).toBe('none')
  })
})
