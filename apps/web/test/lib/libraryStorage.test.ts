import { beforeEach, describe, expect, it } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { Track } from '@pterosaur/shared/types'
import type { LibraryState } from '../../src/store/library.js'
import { LIBRARY_STORE, idbClear } from '../../src/lib/idb.js'
import {
  flushLibraryWrites,
  libraryStorage,
} from '../../src/lib/libraryStorage.js'
const NAME = 'pterosaur-library'

const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: `曲目 ${id}`,
  artist: '艺人',
  album: '专辑',
  cover: '',
  duration: 0,
  fee: 'free',
})

const emptyState = (): LibraryState => ({
  favorites: [],
  recent: [],
  playlists: [],
  savedPlaylists: [],
  savedArtists: [],
  savedAlbums: [],
})

const envelope = (state: LibraryState): StorageValue<LibraryState> => ({
  state,
  version: 0,
})

beforeEach(async () => {
  localStorage.clear()
  await idbClear(LIBRARY_STORE)
})

describe('libraryStorage', () => {
  it('缺失 key 时返回 null', async () => {
    expect(await libraryStorage.getItem(NAME)).toBeNull()
  })

  it('写入并 flush 后可读回', async () => {
    const value = envelope({ ...emptyState(), favorites: [track('1')] })
    await libraryStorage.setItem(NAME, value)
    await flushLibraryWrites()

    const got = await libraryStorage.getItem(NAME)
    expect(got?.state.favorites).toHaveLength(1)
    expect(got?.state.favorites[0].id).toBe('1')
  })

  it('一次性迁移：旧 localStorage 被读取、写入 IDB 并清除旧键（幂等）', async () => {
    const legacy = envelope({ ...emptyState(), recent: [track('9')] })
    localStorage.setItem(NAME, JSON.stringify(legacy))

    const got = await libraryStorage.getItem(NAME)
    expect(got?.state.recent[0].id).toBe('9')
    // 旧键已被清除（幂等标记）
    expect(localStorage.getItem(NAME)).toBeNull()

    // 再次读取走 IDB，值仍在
    const again = await libraryStorage.getItem(NAME)
    expect(again?.state.recent[0].id).toBe('9')
  })

  it('脏的旧数据被忽略并清除，不抛异常', async () => {
    localStorage.setItem(NAME, '{ 不是合法 JSON')
    expect(await libraryStorage.getItem(NAME)).toBeNull()
    expect(localStorage.getItem(NAME)).toBeNull()
  })

  it('形状非法（缺 state）的旧数据被忽略并清除', async () => {
    localStorage.setItem(NAME, JSON.stringify({ foo: 1 }))
    expect(await libraryStorage.getItem(NAME)).toBeNull()
    expect(localStorage.getItem(NAME)).toBeNull()
  })
})
