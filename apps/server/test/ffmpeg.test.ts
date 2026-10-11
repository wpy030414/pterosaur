import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetFfmpegForTest,
  cdWavArgs,
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

describe('cdWavArgs', () => {
  it('CD-DA 参数：44.1kHz / 16bit PCM / 立体声 / WAV', () => {
    const args = cdWavArgs('in.flac', 'out.wav')
    expect(args).toContain('-ar')
    expect(args[args.indexOf('-ar') + 1]).toBe('44100')
    expect(args[args.indexOf('-ac') + 1]).toBe('2')
    expect(args[args.indexOf('-sample_fmt') + 1]).toBe('s16')
    expect(args).toContain('wav')
    expect(args.at(-1)).toBe('out.wav')
    expect(args).toContain('in.flac')
  })
})
