import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryData, SyncEnvelope, Track } from '@pterosaur/shared/types'
import {
  applyPayload,
  emptyLibrary,
  snapshotLibrary,
  startEventStream,
  syncOnEntry,
} from '../../src/lib/sync.js'
import { api } from '../../src/api/client.js'
import { useLibrary } from '../../src/store/library.js'
import { useSync } from '../../src/store/sync.js'

vi.mock('../../src/api/client.js', () => ({
  api: { syncGet: vi.fn(), syncPut: vi.fn() },
}))

const emptyLib = (): LibraryData => ({
  favorites: [],
  recent: [],
  playlists: [],
  savedPlaylists: [],
  savedArtists: [],
  savedAlbums: [],
})

const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: 't',
  artist: 'a',
  album: '',
  cover: '',
  duration: 0,
  fee: 'free',
})

const envelope = (rev: number, state: LibraryData = emptyLib()): SyncEnvelope => ({
  state,
  updatedAt: 0,
  rev,
})

beforeEach(() => {
  useLibrary.setState(emptyLib())
  useSync.setState({ enabled: true, source: 'netease', accountId: '9', rev: 0 })
})

describe('snapshotLibrary / emptyLibrary', () => {
  it('快照只含可同步的数据字段', () => {
    useLibrary.getState().toggleFavorite(track('1'))
    expect(snapshotLibrary().favorites.map((t) => t.id)).toEqual(['1'])
    expect(Object.keys(snapshotLibrary()).sort()).toEqual(
      [
        'favorites',
        'playlists',
        'recent',
        'savedAlbums',
        'savedArtists',
        'savedPlaylists',
      ].sort(),
    )
  })

  it('emptyLibrary 为六个空数组', () => {
    expect(emptyLibrary()).toEqual(emptyLib())
  })
})

describe('applyPayload 归一化', () => {
  it('旧云端载荷缺 savedArtists 时补齐为 []，不残留 undefined', () => {
    const legacy: Partial<LibraryData> = {
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedAlbums: [],
    }
    applyPayload(legacy, 123)
    const s = useLibrary.getState()
    expect(s.savedArtists).toEqual([])
    expect(s.savedAlbums).toEqual([])
    expect(useSync.getState().rev).toBe(123)
  })
})

describe('syncOnEntry（云端权威）', () => {
  it('云端有数据 → 以云端覆盖本地（丢弃本地）', async () => {
    useLibrary.setState({ ...emptyLib(), favorites: [track('local')] })
    vi.mocked(api.syncGet).mockResolvedValue({
      payload: envelope(5, { ...emptyLib(), favorites: [track('srv')] }),
    })

    await syncOnEntry()

    expect(useLibrary.getState().favorites.map((t) => t.id)).toEqual(['srv'])
    expect(useSync.getState().rev).toBe(5)
    expect(api.syncPut).not.toHaveBeenCalled()
  })

  it('云端为空 → 以本地为准并上传', async () => {
    useLibrary.setState({ ...emptyLib(), favorites: [track('local')] })
    vi.mocked(api.syncGet).mockResolvedValue({ payload: null })
    vi.mocked(api.syncPut).mockResolvedValue(envelope(1))

    await syncOnEntry()

    expect(api.syncPut).toHaveBeenCalledWith({
      ...emptyLib(),
      favorites: [track('local')],
    })
    expect(useSync.getState().rev).toBe(1)
  })
})

/** 可控的最小 EventSource 替身（jsdom 不提供 EventSource）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, ((ev: MessageEvent) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  emit(type: string, data: string): void {
    for (const cb of this.listeners[type] ?? []) cb({ data } as MessageEvent)
  }

  close(): void {
    this.closed = true
  }
}

describe('startEventStream（SSE）', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('收到更新的 rev → 重拉并应用（云端权威）', async () => {
    vi.mocked(api.syncGet).mockResolvedValue({
      payload: envelope(7, { ...emptyLib(), favorites: [track('srv')] }),
    })
    useSync.setState({ rev: 1 })

    const stop = startEventStream()
    FakeEventSource.instances[0].emit('rev', JSON.stringify({ rev: 7 }))

    await vi.waitFor(() => expect(useSync.getState().rev).toBe(7))
    expect(useLibrary.getState().favorites.map((t) => t.id)).toEqual(['srv'])
    stop()
  })

  it('忽略不大于本机 rev 的回声', async () => {
    useSync.setState({ rev: 7 })
    const stop = startEventStream()
    FakeEventSource.instances[0].emit('rev', JSON.stringify({ rev: 7 }))
    await Promise.resolve()
    expect(api.syncGet).not.toHaveBeenCalled()
    stop()
  })

  it('断开后每 5s 重连一次（永不停止）', () => {
    vi.useFakeTimers()
    const stop = startEventStream()
    expect(FakeEventSource.instances.length).toBe(1)

    FakeEventSource.instances[0].onerror?.(null)
    vi.advanceTimersByTime(4999)
    expect(FakeEventSource.instances.length).toBe(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances.length).toBe(2)

    stop()
  })
})
