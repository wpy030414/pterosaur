import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENV_PATH, loadEnv, upsertEnv } from '../src/env.js'

describe('ENV_PATH', () => {
  it('指向仓库根（同级存在 pnpm-workspace.yaml 与 package.json）', () => {
    expect(basename(ENV_PATH)).toBe('.env')
    const root = dirname(ENV_PATH)
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })
})

describe('upsertEnv', () => {
  let dir: string | undefined

  /** 造一个临时 .env；传 undefined 表示不创建文件。 */
  const make = (content?: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'pterosaur-env-'))
    const p = join(dir, '.env')
    if (content !== undefined) writeFileSync(p, content, 'utf8')
    return p
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    delete process.env.NETEASE_COOKIE
  })

  it('替换已存在的键，保留其它行与注释', () => {
    const p = make('# 注释\nPORT=8788\nNETEASE_COOKIE=old\nHOST=0.0.0.0\n')
    upsertEnv('NETEASE_COOKIE', 'MUSIC_U=a; __csrf=b', p)
    const out = readFileSync(p, 'utf8')
    expect(out).toContain('# 注释')
    expect(out).toContain('PORT=8788')
    expect(out).toContain('HOST=0.0.0.0')
    expect(out).toContain('NETEASE_COOKIE=MUSIC_U=a; __csrf=b')
    expect(out).not.toContain('NETEASE_COOKIE=old')
    expect(out.match(/NETEASE_COOKIE=/g)).toHaveLength(1)
    expect(out.endsWith('\n')).toBe(true)
  })

  it('键不存在时追加，且不重复插入', () => {
    const p = make('PORT=8788\n')
    upsertEnv('NETEASE_COOKIE', 'x', p)
    const out = readFileSync(p, 'utf8')
    expect(out).toContain('PORT=8788')
    expect(out).toContain('NETEASE_COOKIE=x')
    expect(out.match(/NETEASE_COOKIE=/g)).toHaveLength(1)
  })

  it('支持 export KEY= 形态的就地替换', () => {
    const p = make('export NETEASE_COOKIE=old\n')
    upsertEnv('NETEASE_COOKIE', 'new', p)
    const out = readFileSync(p, 'utf8')
    expect(out).toContain('NETEASE_COOKIE=new')
    expect(out).not.toContain('old')
    expect(out.match(/NETEASE_COOKIE=/g)).toHaveLength(1)
  })

  it('文件不存在时新建', () => {
    const p = make()
    upsertEnv('NETEASE_COOKIE', 'y', p)
    expect(readFileSync(p, 'utf8')).toBe('NETEASE_COOKIE=y\n')
  })

  it('含 ; = 与空格的 cookie 值可被 loadEnv 原样读回', () => {
    const p = make()
    const cookie = 'MUSIC_U=ABC.def; __csrf=123; NMTID=zzz'
    upsertEnv('NETEASE_COOKIE', cookie, p)
    loadEnv(p)
    expect(process.env.NETEASE_COOKIE).toBe(cookie)
  })
})
