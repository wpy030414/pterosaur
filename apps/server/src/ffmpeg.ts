import { spawn } from 'node:child_process'
import { appendFile, stat } from 'node:fs/promises'

/**
 * 静态集成的 ffmpeg（音频 CD 转码依赖，见 ADR-048）。
 *
 * 解析顺序：`PTEROSAUR_FFMPEG_PATH` 环境变量（逃生舱）→ `@ffmpeg-installer/ffmpeg`
 * 静态包——其平台二进制经 **optionalDependencies** 随 npm 分发（无 postinstall、镜像友好），
 * 不要求用户手动安装。平台包缺失时整体不可用（音频 CD 禁用），不影响数据 CD 与数字分发。
 */

let resolved: string | null | undefined

/**
 * 解析 ffmpeg 可执行文件路径；不可用返回 null。结果 memo（含 null）。
 */
export async function resolveFfmpegPath(): Promise<string | null> {
  if (resolved !== undefined) return resolved
  const envPath = process.env.PTEROSAUR_FFMPEG_PATH?.trim()
  if (envPath) {
    resolved = envPath
    return resolved
  }
  try {
    const mod: unknown = await import('@ffmpeg-installer/ffmpeg')
    const path =
      (mod as { default?: { path?: string } }).default?.path ??
      (mod as { path?: string }).path
    resolved = typeof path === 'string' && path ? path : null
  } catch {
    // 平台不匹配 / 包缺失：静默降级
    resolved = null
  }
  return resolved
}

/** 供测试重置 memo。 */
export function _resetFfmpegForTest(): void {
  resolved = undefined
}

/** 探测 ffmpeg 版本（`ffmpeg -version` 首行版本号）；不可执行返回 null。 */
export async function ffmpegVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await runProcess(bin, ['-version'], 5_000)
    return stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown'
  } catch {
    return null
  }
}

/**
 * CD-DA 标准参数：44.1kHz / 16bit / 立体声，输出**裸 PCM**（`s16le`，无 RIFF 头）。
 *
 * IMAPI2 `AddAudioTrack` 的流须是「WAV 去掉头部」的裸采样数据（MSDN 原文；
 * 喂带头的 WAV 会被判 `E_IMAPI_DF2TAO_STREAM_NOT_SUPPORTED`，见 ADR-048 真机修正）。
 */
export function cdPcmArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-vn',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-sample_fmt',
    's16',
    '-f',
    's16le',
    output,
  ]
}

/** 把任意源音频转成可刻录的 CD-DA 裸 PCM；失败抛出（携 stderr 尾部）。 */
export async function toCdPcm(
  bin: string,
  input: string,
  output: string,
): Promise<void> {
  await runProcess(bin, cdPcmArgs(input, output), 10 * 60_000)
}

/**
 * 将 PCM 文件补零对齐到 **CD 扇区边界**（2352 字节）。
 *
 * 部分源的时长与元数据存在亚秒级偏差（实测专辑《David Tao》15 轨中 2 轨未对齐），
 * 而 CD-DA 的帧是定长的——尾帧不足即以静音补满，保证 `AddTrack` 消费的流严格
 * 按扇区成立（见 ADR-048）。
 */
export async function padToCdSector(path: string): Promise<void> {
  const { size } = await stat(path)
  const pad = (2352 - (size % 2352)) % 2352
  if (pad > 0) await appendFile(path, Buffer.alloc(pad))
}

/** 运行外部进程：收集 stdout、环形保留 stderr 尾 10 行；超时强杀、非 0 退出抛错。 */
function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    let stdout = ''
    const stderrTail: string[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8')
    })
    child.stderr.on('data', (buf: Buffer) => {
      for (const l of buf.toString('utf8').split(/\r?\n/)) {
        if (!l.trim()) continue
        stderrTail.push(l)
        if (stderrTail.length > 10) stderrTail.shift()
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${cmd} 启动失败：${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${cmd} 执行超时`))
        return
      }
      if (code !== 0) {
        reject(
          new Error(
            `${cmd} 退出码 ${code}：${stderrTail.join(' | ') || '无输出'}`,
          ),
        )
        return
      }
      resolve({ stdout })
    })
  })
}
