import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'

/**
 * 统一的 SSE 通道（云同步 `/api/sync/events` 与刻录 `/api/rip/events` 共用）。
 *
 * 两条流此前各手写一遍 25s 心跳 + onAbort 退订，且只有一条发首帧快照；此处收敛为同一实现：
 * - `snapshot` 给出时，**订阅之后**写首帧，消除「订阅晚于事件产生 / 事件刚结束」的竞态；
 * - `subscribe` 返回退订函数，心跳失败或连接中止时调用（退订只做一次）；
 * - `X-Accel-Buffering: no` 关掉 nginx 缓冲，心跳压过反代空闲超时。
 */
export function sseChannel<T = never>(
  c: Context,
  subscribe: (stream: SSEStreamingApi) => (() => void) | void,
  snapshot?: () => T,
): Response {
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache')
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe(stream)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
    }
    if (snapshot) {
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify(snapshot()),
      })
    }
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {
          clearInterval(timer)
          close()
          resolve()
        })
      }, 25_000)
      stream.onAbort(() => {
        clearInterval(timer)
        close()
        resolve()
      })
    })
  })
}
