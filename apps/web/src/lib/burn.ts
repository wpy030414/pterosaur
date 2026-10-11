import type { AudioLevel, Track } from '@pterosaur/shared/types'
import { API_BASE } from '@pterosaur/shared/types'
import type {
  DiscType,
  RipEvent,
  RipMeta,
  RipMetaInput,
  RipPhase,
} from '@pterosaur/shared/rip'
import { api } from '../api/client.js'

/**
 * 实体刻录（后端直刻）的前端链路，见 ADR-048。
 *
 * 与后端的契约：**先建立 SSE**（`GET /api/rip/events`）再 `POST /api/rip/burn`，
 * 避免错过任务早期事件；连接建立时服务端先发**快照帧**（当前任务 + 最近终态，
 * 终态保留约 60s），因此断线重连 / 订阅竞态都靠快照帧收敛。
 * SSE 静默超过 15s 时退化为轮询 `/api/rip/status` 兜底。
 */

/** 解析 SSE 事件载荷；非本协议的 JSON（心跳等）返回 null。 */
export function parseRipSseEvent(data: string): RipEvent | null {
  let o: unknown
  try {
    o = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const type = (o as Record<string, unknown>).type
  if (
    type === 'state' ||
    type === 'progress' ||
    type === 'done' ||
    type === 'error'
  )
    return o as RipEvent
  return null
}

export interface BurnProgress {
  phase: RipPhase
  current: number
  total: number
  percent: number | null
}

export interface BurnPlaylistOptions {
  tracks: Track[]
  /** 合集描述（distribution 为 `physical`、`discType` 已按用户选择填好）。 */
  meta: RipMetaInput
  discType: DiscType
  level: AudioLevel
}

/**
 * 发起一次实体刻录并等待终态。
 *
 * @returns 服务端构建的 `meta.json` 对象（数据 CD 已随盘上盘；本侧负责另存一份）
 * @throws 发起失败（403/409/400…）或刻录失败（错误文案来自服务端）
 */
export function burnPlaylist(
  opts: BurnPlaylistOptions,
  onProgress: (p: BurnProgress) => void,
): Promise<RipMeta> {
  return new Promise<RipMeta>((resolve, reject) => {
    // 本机直刻：后端时间戳与本机同钟，用「请求发起时刻」过滤快照帧里
    // **上一次**刻录的陈旧终态（60s 回放窗口内连烧两张的边界）
    const requestStartedAt = Date.now()
    const es = new EventSource(`${API_BASE}/rip/events`)
    let settled = false
    let lastEventAt = Date.now()
    let watchdog: number | undefined

    const finish = (value: RipMeta | Error) => {
      if (settled) return
      settled = true
      if (watchdog !== undefined) window.clearInterval(watchdog)
      es.close()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }

    es.onmessage = (e: MessageEvent) => {
      lastEventAt = Date.now()
      const ev = parseRipSseEvent(String(e.data))
      if (!ev) return
      switch (ev.type) {
        case 'state':
          if (ev.job)
            onProgress({
              phase: ev.job.phase,
              current: ev.job.current,
              total: ev.job.total,
              percent: ev.job.percent,
            })
          // 终态回放：仅采信本次请求发起之后的记录（防上一次刻录的陈旧终态）
          if (ev.last && ev.last.at >= requestStartedAt) {
            if (ev.last.status === 'done' && ev.last.meta) finish(ev.last.meta)
            else if (ev.last.status === 'error')
              finish(new Error(ev.last.error ?? '刻录失败'))
          }
          break
        case 'progress':
          onProgress({
            phase: ev.phase,
            current: ev.current,
            total: ev.total,
            percent: ev.percent,
          })
          break
        case 'done':
          finish(ev.meta)
          break
        case 'error':
          finish(new Error(ev.message))
          break
      }
    }
    es.onerror = () => {
      // EventSource 自带重连；重连后的快照帧会收敛状态，此处无需处理
    }

    api
      .ripBurn({
        meta: opts.meta,
        tracks: opts.tracks,
        discType: opts.discType,
        level: opts.level,
      })
      .catch((err: unknown) => {
        finish(err instanceof Error ? err : new Error('发起刻录失败'))
      })

    // 兜底轮询：SSE 静默超过 15s（断线重连空窗 / 代理缓冲）时查一次任务状态
    watchdog = window.setInterval(() => {
      if (settled || Date.now() - lastEventAt < 15_000) return
      void api
        .ripStatus()
        .then(({ job, last }) => {
          if (last && last.at >= requestStartedAt) {
            if (last.status === 'done' && last.meta) finish(last.meta)
            else if (last.status === 'error')
              finish(new Error(last.error ?? '刻录失败'))
          }
          if (!settled && job)
            onProgress({
              phase: job.phase,
              current: job.current,
              total: job.total,
              percent: job.percent,
            })
        })
        .catch(() => {
          /* 轮询失败忽略，下一轮再试 */
        })
    }, 5_000)
  })
}
