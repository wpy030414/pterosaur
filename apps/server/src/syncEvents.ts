import type { SSEStreamingApi } from 'hono/streaming'

/**
 * 云同步的服务端 **SSE 订阅注册表**（进程内，模块级）。
 *
 * 多设备同时在网时，一端推送后服务端即向其账号下的其它连接广播一个**轻量版本信号**
 * （只含 `rev`，不含整份 state）：客户端据 `rev` 判断云端是否更新、按需重拉。
 * 事件小、幂等、能容忍丢事件——SSE 断线重连后仍以「重拉当前文档」收敛。
 *
 * 注册表以同步键（`<source>-<accountId>`）分组；连接关闭（`stream.onAbort`）时须退订，
 * 否则会持有已断开的流（见 app.ts 的 `/api/sync/events` 路由）。
 */

const subscribers = new Map<string, Set<SSEStreamingApi>>()

/** 订阅某账号的版本信号；返回退订函数（幂等）。 */
export function subscribe(key: string, stream: SSEStreamingApi): () => void {
  let set = subscribers.get(key)
  if (!set) {
    set = new Set()
    subscribers.set(key, set)
  }
  set.add(stream)
  return () => {
    const s = subscribers.get(key)
    if (!s) return
    s.delete(stream)
    if (s.size === 0) subscribers.delete(key)
  }
}

/** 向某账号的全部连接广播一个版本信号（写失败则忽略）。 */
export function broadcast(key: string, payload: { rev: number }): void {
  const set = subscribers.get(key)
  if (!set?.size) return
  const data = JSON.stringify(payload)
  for (const stream of set) {
    void stream.writeSSE({ event: 'rev', data }).catch(() => {
      /* 连接已断开：交给 onAbort 清理 */
    })
  }
}

/** 某账号当前订阅数（供测试断言）。 */
export function subscriberCount(key: string): number {
  return subscribers.get(key)?.size ?? 0
}
