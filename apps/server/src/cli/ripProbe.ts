/**
 * `pnpm rip:probe` —— 直刻环境体检入口（插盘后手动验证用，见 ADR-048）。
 *
 * 打印刻录机 / 介质状态 / 容量与静态 ffmpeg 可用性；无光驱时输出空列表而不报错，
 * 便于在带刻录机的目标机上快速确认「插盘即用」。
 */
import { loadEnv } from '../env.js'
import { ffmpegVersion, resolveFfmpegPath } from '../ffmpeg.js'
import { probeDisc } from '../imapi.js'

loadEnv()

async function main(): Promise<void> {
  console.log('[pterosaur] 直刻环境探测')
  try {
    const probe = await probeDisc()
    console.log(
      `  平台：${process.platform}${probe.simulated ? '（模拟刻录已开启）' : ''}`,
    )
    if (probe.recorders.length === 0) {
      console.log('  刻录机：未检测到')
    } else {
      for (const r of probe.recorders)
        console.log(`  刻录机：${r.product || r.id}`)
    }
    console.log(
      `  介质：${
        probe.mediaPresent
          ? probe.blank
            ? `${probe.profile ?? '可写介质'}（可刻录）`
            : `${probe.profile ?? '未知介质'}（不可写）`
          : '未放盘'
      }`,
    )
    if (probe.capacityBytes)
      console.log(
        `  容量：约 ${Math.round(probe.capacityBytes / 1024 / 1024)} MB`,
      )
    if (probe.mediaPresent) {
      console.log(
        `  数据 CD：${probe.dataSupported ? '可刻录' : '不支持当前介质'}`,
      )
      console.log(
        `  音频 CD：${probe.audioSupported ? '可刻录（另需 ffmpeg 转码）' : '不支持当前介质'}`,
      )
    }
  } catch (err) {
    console.error(`  探测失败：${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }

  const bin = await resolveFfmpegPath()
  if (!bin) {
    console.log(
      '  ffmpeg：不可用（音频 CD 将禁用；可设 PTEROSAUR_FFMPEG_PATH）',
    )
  } else {
    const version = await ffmpegVersion(bin)
    console.log(
      `  ffmpeg：${bin}${version ? `（${version}）` : '（不可执行）'}`,
    )
  }
}

void main()
