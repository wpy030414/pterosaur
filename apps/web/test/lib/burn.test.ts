import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RipMeta, RipMetaInput } from '@pterosaur/shared/rip'
import type { Track } from '@pterosaur/shared/types'
import { api } from '../../src/api/client.js'
import { burnPlaylist, parseRipSseEvent } from '../../src/lib/burn.js'

vi.mock('../../src/api/client.js', () => ({
  api: { ripBurn: vi.fn(), ripStatus: vi.fn() },
}))

/** 可编程的假 EventSource（jsdom 无实现）：捕获实例、手动派发事件。 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: `曲-${id}`,
  artist: '艺术家',
  album: '专辑',
  cover: 'https://p3.music.126.net/x.jpg',
  duration: 180,
  fee: 'free',
})

const metaInput: RipMetaInput = {
  distribution: 'physical',
  discType: 'data',
  kind: 'playlist',
  name: '测试合集',
  source: 'netease',
  level: 'exhigh',
}

const mkMeta = (name: string): RipMeta => ({
  schema: 'pterosaur-rip@1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  distribution: 'physical',
  discType: 'data',
  kind: 'playlist',
  name,
  trackCount: 1,
  totalDuration: 180,
  level: 'exhigh',
  tracks: [],
})

const callBurn = (onProgress = vi.fn()) =>
  burnPlaylist(
    {
      tracks: [track('a')],
      meta: metaInput,
      discType: 'data',
      level: 'exhigh',
    },
    onProgress,
  )

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.mocked(api.ripBurn).mockReset().mockResolvedValue({ jobId: 'job-1' })
  vi.mocked(api.ripStatus).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseRipSseEvent', () => {
  it('解析本协议事件；其余返回 null', () => {
    expect(parseRipSseEvent('{"type":"done"}')).toEqual({ type: 'done' })
    expect(
      parseRipSseEvent(
        '{"type":"progress","phase":"fetch","current":1,"total":2,"percent":null}',
      ),
    ).toMatchObject({ type: 'progress', phase: 'fetch' })
    expect(parseRipSseEvent('not json')).toBeNull()
    expect(parseRipSseEvent('{"type":"ping"}')).toBeNull()
    expect(parseRipSseEvent('42')).toBeNull()
  })
})

describe('burnPlaylist', () => {
  it('先建 SSE 再 POST；done 事件 resolve 并关闭流', async () => {
    let esCountAtPost = 0
    vi.mocked(api.ripBurn).mockImplementation(async () => {
      esCountAtPost = FakeEventSource.instances.length
      return { jobId: 'j1' }
    })
    const onProgress = vi.fn()
    const p = callBurn(onProgress)
    expect(FakeEventSource.instances).toHaveLength(1)
    const es = FakeEventSource.instances[0]

    es.emit({
      type: 'progress',
      phase: 'fetch',
      current: 1,
      total: 1,
      percent: null,
    })
    const doneMeta = mkMeta('完成')
    es.emit({ type: 'done', meta: doneMeta })

    await expect(p).resolves.toEqual(doneMeta)
    expect(esCountAtPost).toBe(1)
    expect(es.closed).toBe(true)
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'fetch',
      current: 1,
      total: 1,
      percent: null,
    })
  })

  it('error 事件以服务端文案 reject', async () => {
    const p = callBurn()
    const es = FakeEventSource.instances[0]
    es.emit({ type: 'error', phase: 'fetch', message: '未检测到刻录机' })
    await expect(p).rejects.toThrow('未检测到刻录机')
    expect(es.closed).toBe(true)
  })

  it('发起失败（如 409）即 reject', async () => {
    vi.mocked(api.ripBurn).mockRejectedValue(new Error('已有刻录任务进行中'))
    const p = callBurn()
    await expect(p).rejects.toThrow('已有刻录任务进行中')
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('快照帧：忽略陈旧终态（at 早于本次请求），采纳本次终态', async () => {
    const p = callBurn()
    const es = FakeEventSource.instances[0]
    // 陈旧终态（上一次刻录的回放）：at=0 早于请求发起时刻——若被误采信会解析为「旧」
    es.emit({
      type: 'state',
      job: null,
      last: { status: 'done', meta: mkMeta('旧'), at: 0 },
    })
    const fresh = mkMeta('新')
    es.emit({
      type: 'state',
      job: null,
      last: { status: 'done', meta: fresh, at: Date.now() },
    })
    await expect(p).resolves.toEqual(fresh)
  })

  it('watchdog：SSE 静默超 15s 时轮询 status 兜底', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.ripStatus).mockResolvedValue({
        job: {
          jobId: 'j1',
          phase: 'burn',
          current: 0,
          total: 1,
          percent: null,
          discType: 'data',
          startedAt: 0,
        },
        last: null,
      })
      const onProgress = vi.fn()
      const p = callBurn(onProgress)

      await vi.advanceTimersByTimeAsync(16_000)
      expect(api.ripStatus).toHaveBeenCalled()
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'burn', percent: null }),
      )

      // 收拾悬置的 promise：以 done 事件收尾
      const doneMeta = mkMeta('完成')
      FakeEventSource.instances[0].emit({ type: 'done', meta: doneMeta })
      await expect(p).resolves.toEqual(doneMeta)
    } finally {
      vi.useRealTimers()
    }
  })
})
