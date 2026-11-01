import { beforeEach, describe, expect, it } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { Track } from '@pterosaur/shared/types'
import type { QueueState } from '../../src/store/playerQueue.js'
import { LIBRARY_STORE, idbClear, idbPut } from '../../src/lib/idb.js'
import {
  PLAYER_QUEUE_STORE_KEY,
  flushPlayerQueueWrites,
  playerQueueStorage,
} from '../../src/lib/playerQueueStorage.js'

const NAME = PLAYER_QUEUE_STORE_KEY

const track = (id: string): Track => ({
  source: 'netease',
  id,
  title: `曲目 ${id}`,
  artist: '艺术家',
  album: '专辑',
  cover: '',
  duration: 0,
  fee: 'free',
})

const queueState = (ids: string[]): QueueState => ({
  queue: ids.map(track),
  baseQueue: ids.map(track),
  index: 0,
  volume: 0.5,
  muted: true,
  repeat: 'one',
  shuffle: true,
  lastKey: null,
})

const envelope = (state: QueueState): StorageValue<QueueState> => ({
  state,
  version: 0,
})

beforeEach(async () => {
  localStorage.clear()
  await idbClear(LIBRARY_STORE)
})

describe('playerQueueStorage', () => {
  it('缺失 key 时返回 null', async () => {
    expect(await playerQueueStorage.getItem(NAME)).toBeNull()
  })

  it('写入并 flush 后可读回（含音量 / 循环等偏好）', async () => {
    await playerQueueStorage.setItem(NAME, envelope(queueState(['1', '2'])))
    await flushPlayerQueueWrites()

    const got = await playerQueueStorage.getItem(NAME)
    expect(got?.state.queue.map((t) => t.id)).toEqual(['1', '2'])
    expect(got?.state.muted).toBe(true)
    expect(got?.state.repeat).toBe('one')
    expect(got?.state.shuffle).toBe(true)
  })

  it('一次性迁移：旧 pterosaur-player 键被读取、只保留队列与偏好、并清除旧键', async () => {
    // 旧版载荷：混有播放态字段（isPlaying / position / expanded…），迁移时必须丢弃
    const legacy = {
      state: {
        queue: [track('7')],
        baseQueue: [track('7')],
        index: 0,
        current: track('7'),
        volume: 0.3,
        muted: false,
        repeat: 'all',
        shuffle: false,
        isPlaying: true,
        position: 42,
        duration: 100,
        expanded: true,
        playError: 'boom',
      },
      version: 0,
    }
    localStorage.setItem('pterosaur-player', JSON.stringify(legacy))

    const got = await playerQueueStorage.getItem(NAME)
    expect(localStorage.getItem('pterosaur-player')).toBeNull() // 迁移后清除
    expect(got?.state.queue.map((t) => t.id)).toEqual(['7'])
    expect(got?.state.volume).toBe(0.3)
    expect(got?.state).not.toHaveProperty('isPlaying')
    expect(got?.state).not.toHaveProperty('position')
    expect(got?.state).not.toHaveProperty('expanded')
    // 旧载荷没有播放锚点：按同下标补全为队列里当前那首
    expect(got?.state.lastKey).toBe('netease:7')
  })

  it('旧 IDB 记录缺 lastKey 时按同下标补全并回写', async () => {
    const { lastKey: _ignored, ...withoutAnchor } = queueState(['3', '4'])
    await idbPut(
      LIBRARY_STORE,
      { state: { ...withoutAnchor, index: 1 }, version: 0 },
      NAME,
    )

    const got = await playerQueueStorage.getItem(NAME)
    expect(got?.state.lastKey).toBe('netease:4')
    // 回写后再次读取不再走补全分支，读到的仍是同一个锚点
    const again = await playerQueueStorage.getItem(NAME)
    expect(again?.state.lastKey).toBe('netease:4')
  })

  it('旧键内容损坏时删除旧键、正常返回 null（不反复重试）', async () => {
    localStorage.setItem('pterosaur-player', '{not json')
    expect(await playerQueueStorage.getItem(NAME)).toBeNull()
    expect(localStorage.getItem('pterosaur-player')).toBeNull()
  })
})
