import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePresence } from '../../src/hooks/usePresence.js'

describe('usePresence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('初始关闭时不挂载', () => {
    const { result } = renderHook(({ open }) => usePresence(open, 400), {
      initialProps: { open: false },
    })
    expect(result.current.mounted).toBe(false)
    expect(result.current.exiting).toBe(false)
  })

  it('打开后挂载；关闭进入退出，超时后卸载', () => {
    const { result, rerender } = renderHook(
      ({ open }) => usePresence(open, 400),
      {
        initialProps: { open: false },
      },
    )

    rerender({ open: true })
    expect(result.current.mounted).toBe(true)
    expect(result.current.exiting).toBe(false)

    rerender({ open: false })
    expect(result.current.mounted).toBe(true)
    expect(result.current.exiting).toBe(true)

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(result.current.mounted).toBe(false)
    expect(result.current.exiting).toBe(false)
  })

  it('退出期间重新打开会取消卸载', () => {
    const { result, rerender } = renderHook(
      ({ open }) => usePresence(open, 400),
      {
        initialProps: { open: true },
      },
    )

    rerender({ open: false })
    expect(result.current.exiting).toBe(true)

    rerender({ open: true })
    expect(result.current.exiting).toBe(false)

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(result.current.mounted).toBe(true)
  })
})
