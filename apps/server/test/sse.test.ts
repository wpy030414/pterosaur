import { afterEach, describe, expect, it, vi } from 'vitest'
import { sseChannel } from '../src/sse.js'

/**
 * 用最小 Context 替身驱动 sseChannel：真实 `streamSSE` 会把数据写进 `c` 的 raw 响应，
 * 这里只关心「订阅 → 快照 → 退订」的时序与次数，故把 `streamSSE` 换成一个可控桩。
 */
const streamSSEDouble = vi.hoisted(() => {
  const writes: string[] = []
  const stream = {
    writeSSE: ({ event, data }: { event?: string; data: string }) => {
      writes.push(`${event ?? 'message'}:${data}`)
      return Promise.resolve()
    },
    onAbort: (cb: () => void) => {
      // 不立即中止：由用例主动触发（见 runAndFinish / 退订用例）
      stream.abortCb = cb
    },
    abortCb: undefined as undefined | (() => void),
  }
  return { writes, stream }
})

vi.mock('hono/streaming', () => ({
  streamSSE: async (
    _c: unknown,
    run: (s: unknown) => Promise<void>,
  ): Promise<Response> => {
    await run(streamSSEDouble.stream)
    return new Response('ok')
  },
}))

function makeContext() {
  return {
    header: () => undefined,
  } as never
}

/** 稳定引用的退订函数（替身的 onAbort 每次注册都会覆盖，不能传「每次新返回」的闭包）。 */
const NOOP = () => {}

/**
 * 让 `sseChannel` 结束：它只在「心跳写入失败」或「连接中止」时 resolve。
 * 用 `onAbort` 触发即可（与真实断连同路径），无需折腾定时器。
 */
async function finish(p: Response | Promise<Response>) {
  for (let i = 0; i < 100 && !streamSSEDouble.stream.abortCb; i++) {
    await Promise.resolve()
  }
  streamSSEDouble.stream.abortCb?.()
  await p
}

describe('sseChannel', () => {
  afterEach(() => {
    streamSSEDouble.stream.abortCb = undefined
  })
  it('先订阅、再写快照帧（消除「订阅晚于事件」的竞态）', async () => {
    streamSSEDouble.writes.length = 0
    const order: string[] = []
    const p = sseChannel(
      makeContext(),
      () => {
        order.push('subscribe')
        return () => order.push('unsubscribe')
      },
      () => {
        order.push('snapshot')
        return { hello: 1 }
      },
    )
    await finish(p)
    expect(order).toEqual(['subscribe', 'snapshot', 'unsubscribe'])
    expect(streamSSEDouble.writes[0]).toBe('message:{"hello":1}')
  })

  it('不给快照时只订阅不发首帧（云同步线：客户端自行重拉收敛）', async () => {
    streamSSEDouble.writes.length = 0
    await finish(sseChannel(makeContext(), () => NOOP))
    expect(streamSSEDouble.writes).toEqual([])
  })

  it('连接中止时退订恰好一次', async () => {
    const unsubscribe = vi.fn()
    await finish(sseChannel(makeContext(), () => unsubscribe))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
