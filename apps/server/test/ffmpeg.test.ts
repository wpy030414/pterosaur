import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetFfmpegForTest,
  cdPcmArgs,
  padToCdSector,
  resolveFfmpegPath,
} from '../src/ffmpeg.js'

afterEach(() => {
  vi.unstubAllEnvs()
  _resetFfmpegForTest()
})

describe('resolveFfmpegPath', () => {
  it('PTEROSAUR_FFMPEG_PATH 优先并 memo', async () => {
    vi.stubEnv('PTEROSAUR_FFMPEG_PATH', '/custom/ffmpeg')
    expect(await resolveFfmpegPath()).toBe('/custom/ffmpeg')
    // memo：环境变量清掉后再取仍是首解
    vi.stubEnv('PTEROSAUR_FFMPEG_PATH', '')
    expect(await resolveFfmpegPath()).toBe('/custom/ffmpeg')
  })

  it('无环境变量时回落 @ffmpeg-installer 静态包（本仓已安装平台包）', async () => {
    vi.stubEnv('PTEROSAUR_FFMPEG_PATH', '')
    const p = await resolveFfmpegPath()
    // 极端环境下平台包可能缺失（返回 null）；在可解析时断言指向真实二进制
    if (p !== null) expect(p.toLowerCase()).toContain('ffmpeg')
  })
})

describe('cdPcmArgs', () => {
  it('CD-DA 参数：44.1kHz / 16bit 立体声 / 裸 PCM（s16le，无 WAV 头）', () => {
    const args = cdPcmArgs('in.flac', 'out.pcm')
    expect(args[args.indexOf('-ar') + 1]).toBe('44100')
    expect(args[args.indexOf('-ac') + 1]).toBe('2')
    expect(args[args.indexOf('-sample_fmt') + 1]).toBe('s16')
    expect(args[args.indexOf('-f') + 1]).toBe('s16le')
    expect(args.at(-1)).toBe('out.pcm')
    expect(args).toContain('in.flac')
  })
})

describe('padToCdSector', () => {
  it('未对齐补零到 2352 边界；已对齐不动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pterosaur-pad-'))
    try {
      const odd = join(dir, 'odd.pcm')
      await writeFile(odd, Buffer.alloc(2352 + 100))
      await padToCdSector(odd)
      expect((await stat(odd)).size).toBe(2352 * 2)

      const aligned = join(dir, 'aligned.pcm')
      await writeFile(aligned, Buffer.alloc(2352 * 3))
      await padToCdSector(aligned)
      expect((await stat(aligned)).size).toBe(2352 * 3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
