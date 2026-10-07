import { beforeEach, describe, expect, it } from 'vitest'
import type { LibraryData, SyncEnvelope } from '@pterosaur/shared/types'
import {
  applyPayload,
  decideSync,
  emptyLibrary,
  snapshotLibrary,
} from '../../src/lib/sync.js'
import { useLibrary } from '../../src/store/library.js'

const envelope = (updatedAt: number): SyncEnvelope => ({
  state: emptyLibrary(),
  updatedAt,
})

describe('decideSync（LWW）', () => {
  it('云端无数据 → 推送本地', () => {
    expect(decideSync(0, null)).toBe('push')
  })

  it('云端更新 → 采用云端', () => {
    expect(decideSync(100, envelope(200))).toBe('pull')
  })

  it('本地更新或相等 → 推送本地', () => {
    expect(decideSync(300, envelope(200))).toBe('push')
    expect(decideSync(200, envelope(200))).toBe('push')
  })
})

describe('snapshotLibrary / emptyLibrary', () => {
  beforeEach(() => {
    useLibrary.setState({
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedArtists: [],
      savedAlbums: [],
    })
  })

  it('快照只含可同步的数据字段', () => {
    useLibrary.getState().toggleFavorite({
      source: 'netease',
      id: '1',
      title: 't',
      artist: 'a',
      album: '',
      cover: '',
      duration: 0,
      fee: 'free',
    })
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
    expect(emptyLibrary()).toEqual({
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedArtists: [],
      savedAlbums: [],
    })
  })
})

describe('applyPayload 归一化', () => {
  beforeEach(() => {
    useLibrary.setState({
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedArtists: [],
      savedAlbums: [],
    })
  })

  it('旧云端载荷缺 savedArtists 时补齐为 []，不残留 undefined', () => {
    // 模拟 savedArtists 引入前写入的旧载荷
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
    expect(Array.isArray(s.savedArtists)).toBe(true)
  })
})
