import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PS_BURN_SCRIPT,
  PS_PROBE_SCRIPT,
  parsePsLine,
  psErrorMessage,
} from '../src/imapi.js'
import { fakeBurn, fakeProbe } from '../src/imapiFake.js'

describe('parsePsLine', () => {
  it('解析合法事件', () => {
    expect(parsePsLine('{"event":"phase","phase":"writing"}')).toEqual({
      event: 'phase',
      phase: 'writing',
    })
    expect(parsePsLine('{"event":"done"}')).toEqual({ event: 'done' })
    expect(parsePsLine('{"event":"error","code":"no_media"}')).toEqual({
      event: 'error',
      code: 'no_media',
      detail: undefined,
    })
  })

  it('非事件行 / 非法 JSON 返回 null', () => {
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('just a log line')).toBeNull()
    expect(parsePsLine('{bad json')).toBeNull()
    expect(parsePsLine('{"event":123}')).toBeNull()
    expect(parsePsLine('{"foo":1}')).toBeNull()
  })
})

describe('PS 模板守卫', () => {
  it('模板为 ASCII-only（PS 5.1 按 ANSI 解析 .ps1，中文会乱码）', () => {
    expect(/^[\x00-\x7F]*$/.test(PS_PROBE_SCRIPT)).toBe(true)
    expect(/^[\x00-\x7F]*$/.test(PS_BURN_SCRIPT)).toBe(true)
  })

  it('模板不含 `${` 插值残留（模板字符串写入时的转义防线）', () => {
    expect(PS_PROBE_SCRIPT.includes('${')).toBe(false)
    expect(PS_BURN_SCRIPT.includes('${')).toBe(false)
  })

  it('刻录模板含关键 API、编码设置与介质复检', () => {
    for (const token of [
      'MsftDiscMaster2',
      'MsftFileSystemImage',
      'FileSystemsToCreate = 7',
      'MsftDiscFormat2Data',
      'MsftDiscFormat2TrackAtOnce',
      'AddAudioTrack',
      'PrepareMedia',
      'ReleaseMedia',
      '[Console]::OutputEncoding',
      'media_not_blank',
      'media_unsupported_data',
      'media_unsupported_audio',
      'IsCurrentMediaSupported',
      'CurrentPhysicalMediaType',
    ])
      expect(PS_BURN_SCRIPT, token).toContain(token)
  })

  it('模板不使用 CurrentProfileType（空白介质回 NONE=0，见 ADR-048 首测修正）', () => {
    expect(PS_PROBE_SCRIPT.includes('CurrentProfileType')).toBe(false)
    expect(PS_BURN_SCRIPT.includes('CurrentProfileType')).toBe(false)
  })

  it('探测模板含关键 API', () => {
    for (const token of [
      'MsftDiscMaster2',
      'MsftDiscFormat2Data',
      'MsftDiscFormat2TrackAtOnce',
      'CurrentMediaStatus',
      'CurrentPhysicalMediaType',
      'IsCurrentMediaSupported',
    ])
      expect(PS_PROBE_SCRIPT, token).toContain(token)
  })
})

describe('psErrorMessage', () => {
  it('错误码映射为中文，detail 附注', () => {
    expect(psErrorMessage('no_media')).toBe(
      '光驱中未放入光盘（请放入空白 CD-R）',
    )
    expect(psErrorMessage('burn_failed', 'HRESULT 0x80004005')).toContain(
      'HRESULT 0x80004005',
    )
    expect(psErrorMessage('media_unsupported_data')).toContain('不支持数据刻录')
    expect(psErrorMessage('media_unsupported_audio', 'mediaType=9')).toContain(
      '不支持音频 CD 刻录',
    )
    expect(psErrorMessage('unknown_code')).toContain('刻录失败')
  })
})

describe('模拟刻录缝（imapiFake）', () => {
  it('fakeProbe 报告模拟刻录机与可写的 CD-RW', () => {
    const p = fakeProbe()
    expect(p.simulated).toBe(true)
    expect(p.recorders).toHaveLength(1)
    expect(p.mediaPresent).toBe(true)
    expect(p.blank).toBe(true)
    expect(p.profile).toBe('CD-RW')
    expect(p.dataSupported).toBe(true)
    expect(p.audioSupported).toBe(true)
  })

  it('fakeBurn 校验 data 模式产物含 meta.json，并按相位推进到 done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pterosaur-test-'))
    try {
      const events: string[] = []
      // 缺 meta.json：应拒绝（产物断言真实执行）
      await expect(
        fakeBurn({ mode: 'data', stagingDir: dir, volumeLabel: 'X' }, (e) =>
          events.push(e.event),
        ),
      ).rejects.toThrow()

      await writeFile(join(dir, 'meta.json'), '{}')
      await fakeBurn({ mode: 'data', stagingDir: dir, volumeLabel: 'X' }, (e) =>
        events.push(e.event),
      )
      expect(events).toContain('phase')
      expect(events.at(-1)).toBe('done')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fakeBurn 音频模式要求转码轨道非空', async () => {
    await expect(
      fakeBurn(
        {
          mode: 'audio',
          stagingDir: tmpdir(),
          volumeLabel: 'X',
          audioTracks: [],
        },
        () => {},
      ),
    ).rejects.toThrow(/转码轨道/)
  })
})
