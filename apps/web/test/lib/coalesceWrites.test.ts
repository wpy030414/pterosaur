import { describe, expect, it, vi } from 'vitest'
import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { coalesceWrites } from '../../src/lib/coalesceWrites.js'

type S = { n: number }

function makeBase() {
  const writes: StorageValue<S>[] = []
  const base: PersistStorage<S> = {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async (_name, value) => {
      writes.push(value)
    }),
    removeItem: vi.fn(async () => {}),
  }
  return { base, writes }
}

const v = (n: number): StorageValue<S> => ({ state: { n }, version: 0 })
/** 排空微任务与一轮宏任务，使 pending 写落地。 */
const drain = () => new Promise<void>((r) => setTimeout(r, 0))

describe('coalesceWrites', () => {
  it('同一 tick 内多次写入只落盘一次，且为最新值', async () => {
    const { base, writes } = makeBase()
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    s.setItem('k', v(2))
    s.setItem('k', v(3))
    expect(base.setItem).not.toHaveBeenCalled()
    await drain()
    expect(base.setItem).toHaveBeenCalledTimes(1)
    expect(writes[0].state).toEqual({ n: 3 })
  })

  it('跨 tick 的写入各自立即落盘（durability）', async () => {
    const { base } = makeBase()
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    await drain()
    s.setItem('k', v(2))
    await drain()
    expect(base.setItem).toHaveBeenCalledTimes(2)
  })

  it('flush 立即落盘并等待完成', async () => {
    const { base } = makeBase()
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    await s.flush()
    expect(base.setItem).toHaveBeenCalledTimes(1)
  })

  it('removeItem 取消 pending，旧值不复活', async () => {
    const { base } = makeBase()
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    await s.removeItem('k')
    await drain()
    expect(base.setItem).not.toHaveBeenCalled()
    expect(base.removeItem).toHaveBeenCalledTimes(1)
  })

  it('写入串行化，保持顺序', async () => {
    const order: number[] = []
    const base: PersistStorage<S> = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async (_name, value) => {
        await new Promise((r) => setTimeout(r, value.state.n === 1 ? 20 : 0))
        order.push(value.state.n)
      }),
      removeItem: vi.fn(async () => {}),
    }
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    await s.flush()
    s.setItem('k', v(2))
    await s.flush()
    expect(order).toEqual([1, 2])
  })

  it('底层写入失败时不抛出（仅告警）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base: PersistStorage<S> = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {
        throw new Error('boom')
      }),
      removeItem: vi.fn(async () => {}),
    }
    const s = coalesceWrites(base)
    s.setItem('k', v(1))
    await expect(s.flush()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
