import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LibraryData } from '@pterosaur/shared/types'
import {
  MAX_PAYLOAD_BYTES,
  clearLibrary,
  isLibraryState,
  readLibrary,
  writeLibrary,
} from '../src/syncStore.js'
import { closeSyncDb, syncDb } from '../src/syncDb.js'

const state = (): LibraryData => ({
  favorites: [],
  recent: [],
  playlists: [],
  savedPlaylists: [],
  savedArtists: [],
  savedAlbums: [],
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pterosaur-sync-'))
})

afterEach(() => {
  closeSyncDb(dir)
  rmSync(dir, { recursive: true, force: true })
})

describe('syncStore 往返（sqlite）', () => {
  it('写入后可读回同一份数据，且服务端指派 rev=1 与 updatedAt', async () => {
    const saved = await writeLibrary('42', state(), dir)
    expect(saved.rev).toBe(1)
    expect(typeof saved.updatedAt).toBe('number')

    const read = readLibrary('42', dir)
    expect(read).toEqual({
      kind: 'ok',
      envelope: expect.objectContaining({ rev: 1 }),
    })
    expect(read.kind === 'ok' && read.envelope.state).toEqual(state())
  })

  it('再次写入 rev 递增（服务端版本号）', async () => {
    await writeLibrary('42', state(), dir)
    const saved2 = await writeLibrary('42', state(), dir)
    expect(saved2.rev).toBe(2)
    const after = readLibrary('42', dir)
    expect(after.kind === 'ok' && after.envelope.rev).toBe(2)
  })

  it('并发写入各自拿到不同的 rev（原子递增，不出现重复版本号）', async () => {
    const results = await Promise.all([
      writeLibrary('42', state(), dir),
      writeLibrary('42', state(), dir),
      writeLibrary('42', state(), dir),
    ])
    // 三个并发的 rev 必须两两不同，且恰为 1 / 2 / 3
    const revs = results.map((r) => r.rev)
    expect(new Set(revs).size).toBe(3)
    for (const n of [1, 2, 3]) expect(revs).toContain(n)
  })

  it('云端记录损坏 → corrupt（与「不存在」严格区分，避免被本地空库覆盖）', async () => {
    await writeLibrary('42', state(), dir)
    // 绕过 API 直接把行写坏（模拟磁盘损坏 / 旧版本写入了非法形状）
    syncDb(dir)
      .prepare('UPDATE sync_docs SET state = ? WHERE key = ?')
      .run('{"favorites": "not-an-array"}', '42')
    const read = readLibrary('42', dir)
    expect(read.kind).toBe('corrupt')
  })

  it('不同用户相互隔离', async () => {
    await writeLibrary('42', state(), dir)
    expect(readLibrary('99', dir)).toEqual({ kind: 'missing' })
  })

  it('不存在时返回 null', async () => {
    expect(readLibrary('42', dir)).toEqual({ kind: 'missing' })
  })

  it('clearLibrary 删除后读回 null', async () => {
    await writeLibrary('42', state(), dir)
    await clearLibrary('42', dir)
    expect(readLibrary('42', dir)).toEqual({ kind: 'missing' })
  })
})

describe('syncStore 校验与安全', () => {
  it('isLibraryState 宽容：基础集合齐全即可，缺省 / 未知的新字段都放行', () => {
    expect(isLibraryState(null)).toBe(false)
    expect(isLibraryState({})).toBe(false)
    expect(isLibraryState(state())).toBe(true)

    // 缺 savedArtists 的旧载荷
    const legacy: Record<string, unknown> = { ...state() }
    delete legacy.savedArtists
    expect(isLibraryState(legacy)).toBe(true)

    // 含任意新增 / 未知字段（服务端有意不枚举后续字段）
    expect(isLibraryState({ ...state(), someFutureField: 123 })).toBe(true)
  })

  it('写入非法载荷抛错', async () => {
    await expect(
      writeLibrary('42', {} as unknown as LibraryData, dir),
    ).rejects.toThrow()
  })

  it('超过体积上限抛错', async () => {
    const big = state()
    big.favorites = [{ id: 'x', title: 'y'.repeat(MAX_PAYLOAD_BYTES) }] as never
    await expect(writeLibrary('42', big, dir)).rejects.toThrow()
  })

  it('userId 被净化，路径穿越不会逃出数据目录', async () => {
    await writeLibrary('../42', state(), dir)
    const read = readLibrary('42', dir)
    expect(read.kind === 'ok' && read.envelope.state).toEqual(state())
    // 净化为空的非法 id 直接拒绝（读取按「不存在」处理，不报 corrupt）
    await expect(writeLibrary('../', state(), dir)).rejects.toThrow()
    expect(readLibrary('../', dir)).toEqual({ kind: 'missing' })
  })
})

describe('旧 JSON 一次性迁移', () => {
  it('首次打开库时把 <dir>/sync/*.json 导入（rev=1）', async () => {
    const syncDir = join(dir, 'sync')
    mkdirSync(syncDir, { recursive: true })
    writeFileSync(
      join(syncDir, 'netease-7.json'),
      JSON.stringify({ state: state(), updatedAt: 111 }),
    )

    const read = readLibrary('netease-7', dir)
    expect(read).toEqual({
      kind: 'ok',
      envelope: { state: state(), rev: 1, updatedAt: 111 },
    })
  })
})
