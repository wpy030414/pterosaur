import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEnvelope } from '@pterosaur/shared/types'
import {
  MAX_PAYLOAD_BYTES,
  clearLibrary,
  isSyncEnvelope,
  readLibrary,
  writeLibrary,
} from '../src/syncStore.js'

const envelope = (updatedAt = 1): SyncEnvelope => ({
  state: {
    favorites: [],
    recent: [],
    playlists: [],
    savedPlaylists: [],
    savedArtists: [],
    savedAlbums: [],
  },
  updatedAt,
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pterosaur-sync-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('syncStore 往返', () => {
  it('写入后可读回同一份载荷', async () => {
    const env = envelope(123)
    await writeLibrary('42', env, dir)
    expect(await readLibrary('42', dir)).toEqual(env)
  })

  it('不同用户相互隔离', async () => {
    await writeLibrary('42', envelope(1), dir)
    expect(await readLibrary('99', dir)).toBeNull()
  })

  it('不存在时返回 null', async () => {
    expect(await readLibrary('42', dir)).toBeNull()
  })

  it('clearLibrary 删除后读回 null', async () => {
    await writeLibrary('42', envelope(), dir)
    await clearLibrary('42', dir)
    expect(await readLibrary('42', dir)).toBeNull()
  })
})

describe('syncStore 校验与安全', () => {
  it('非法载荷被拒（缺字段 / updatedAt 非数）', () => {
    expect(isSyncEnvelope(null)).toBe(false)
    expect(isSyncEnvelope({ state: {}, updatedAt: 1 })).toBe(false)
    expect(isSyncEnvelope({ state: envelope().state, updatedAt: 'x' })).toBe(
      false,
    )
    expect(isSyncEnvelope(envelope())).toBe(true)
  })

  it('宽容解析：缺失与未知的新字段都不影响校验（旧载荷不被误判非法）', () => {
    // 缺 savedArtists 的旧载荷
    const legacy = {
      state: {
        favorites: [],
        recent: [],
        playlists: [],
        savedPlaylists: [],
        savedAlbums: [],
      },
      updatedAt: 1,
    }
    expect(isSyncEnvelope(legacy)).toBe(true)

    // 含任意新增 / 未知字段的载荷也放行（服务端有意不枚举后续字段）
    const future = {
      state: { ...legacy.state, savedArtists: [], someFutureField: 123 },
      updatedAt: 1,
    }
    expect(isSyncEnvelope(future)).toBe(true)
  })

  it('写入非法载荷抛错', async () => {
    await expect(
      writeLibrary(
        '42',
        { state: {}, updatedAt: 1 } as unknown as SyncEnvelope,
        dir,
      ),
    ).rejects.toThrow()
  })

  it('超过体积上限抛错', async () => {
    const big = envelope()
    big.state.favorites = [
      { id: 'x', title: 'y'.repeat(MAX_PAYLOAD_BYTES) },
    ] as never
    await expect(writeLibrary('42', big, dir)).rejects.toThrow()
  })

  it('userId 被净化，路径穿越不会逃出数据目录', async () => {
    // '../42' → 净化为 '42'，仍落在数据目录内的 sync/42.json
    await writeLibrary('../42', envelope(7), dir)
    expect(await readLibrary('42', dir)).toEqual(envelope(7))
    // 净化为空的非法 id 直接拒绝（读回 null）
    await expect(writeLibrary('../', envelope(), dir)).rejects.toThrow()
    expect(await readLibrary('../', dir)).toBeNull()
  })
})
