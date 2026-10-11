import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  isAudioLevel,
  isMusicSource,
  type AudioLevel,
  type MusicSource,
  type Track,
} from '@pterosaur/shared/types'
import {
  AUDIO_CD_MAX_SECONDS,
  RIP_META_FILE,
  audioCdFitsTotal,
  buildRipMeta,
  extFromImageMime,
  extFromMime,
  ripFileName,
  type DiscType,
  type RipCapabilities,
  type RipEvent,
  type RipJobSnapshot,
  type RipLastResult,
  type RipMeta,
  type RipMetaInput,
  type RipPhase,
} from '@pterosaur/shared/rip'
import {
  UA,
  audioContentTypeFromUrl,
  fetchAudioCandidate,
} from './audioFetch.js'
import { adapterOf } from './sources/index.js'
import { burnDisc, isFakeBurn, probeDisc, psErrorMessage } from './imapi.js'
import {
  ffmpegVersion,
  padToCdSector,
  resolveFfmpegPath,
  toCdPcm,
} from './ffmpeg.js'

/**
 * 实体刻录（后端直刻光驱）的任务引擎，见 ADR-048。
 *
 * - **全局单任务**：进程内同一时刻至多一次刻录（重复发起由路由回 409）；
 * - 进度经订阅表广播（路由 `/api/rip/events` 以 SSE 转发给前端）；
 * - 流程：探测刻录机/介质（**先于**拉取任何音频，无盘立即失败）→ 逐轨拉取落盘
 *   （流式写入，单轨失败 fail-fast，数据 CD 计数守护介质容量）→ 音频 CD 逐轨
 *   ffmpeg 转码 44.1kHz/16bit WAV → data 模式补封面与 meta.json → 调 IMAPI 刻录；
 * - 暂存目录 `os.tmpdir()/pterosaur-burn-*`，无论成败均清理；启动时清扫 24h 残留。
 */

/* ============================ 事件订阅（进程内） ============================ */

type RipListener = (ev: RipEvent) => void

const listeners = new Set<RipListener>()

/** 订阅刻录事件；返回退订函数（幂等）。 */
export function subscribeRip(cb: RipListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function broadcastRip(ev: RipEvent): void {
  for (const cb of listeners) {
    try {
      cb(ev)
    } catch {
      /* 单个订阅者异常不影响其余 */
    }
  }
}

/* ============================ 单任务状态 ============================ */

interface RipJobState {
  id: string
  phase: RipPhase
  current: number
  total: number
  percent: number | null
  discType: DiscType
  startedAt: number
}

let job: RipJobState | null = null

/** 终态保留时长：消除「订阅晚于任务结束」的竞态（SSE 快照帧回放）。 */
const LAST_RESULT_TTL_MS = 60_000
let lastResult: { value: RipLastResult; expiresAt: number } | null = null

/** 当前任务快照（无任务为 null）。 */
export function jobSnapshot(): RipJobSnapshot | null {
  if (!job) return null
  return {
    jobId: job.id,
    phase: job.phase,
    current: job.current,
    total: job.total,
    percent: job.percent,
    discType: job.discType,
    startedAt: job.startedAt,
  }
}

/** 最近一次终态（过期或未产生为 null）。 */
export function lastResultSnapshot(): RipLastResult | null {
  if (!lastResult) return null
  if (Date.now() > lastResult.expiresAt) {
    lastResult = null
    return null
  }
  return lastResult.value
}

function emitProgress(
  phase: RipPhase,
  current: number,
  total: number,
  percent: number | null = null,
): void {
  if (job) {
    job.phase = phase
    job.current = current
    job.total = total
    job.percent = percent
  }
  broadcastRip({ type: 'progress', phase, current, total, percent })
}

/* ============================ 校验与清洗（导出供单测） ============================ */

/** 单次刻录的曲目数上限（约束请求体与暂存规模）。 */
export const MAX_BURN_TRACKS = 500

/** 曲目文本字段的长度上限（防超长载荷撑爆 meta.json / 文件名）。 */
const MAX_TEXT_LEN = 300

export type BurnValidation =
  | {
      ok: true
      value: {
        meta: RipMetaInput
        tracks: Track[]
        discType: DiscType
        level: AudioLevel
      }
    }
  | { ok: false; error: string }

/**
 * 校验 `POST /api/rip/burn` 请求体。
 * 关键约束：曲目**必须同源**（服务端凭证单一）、音频 CD 容量预检（超限拒绝，见 ADR-048）、
 * 文本字段限长（入暂存文件名 / meta.json 前的边界）。
 */
export function validateBurnBody(body: unknown): BurnValidation {
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: '请求体格式错误' }
  const b = body as Record<string, unknown>

  const discType = b.discType
  if (discType !== 'data' && discType !== 'audio')
    return { ok: false, error: '未知的光盘类型' }
  if (!isAudioLevel(b.level)) return { ok: false, error: '未知的音质档位' }

  const rawTracks = b.tracks
  if (!Array.isArray(rawTracks) || rawTracks.length === 0)
    return { ok: false, error: '曲目列表为空' }
  if (rawTracks.length > MAX_BURN_TRACKS)
    return { ok: false, error: `曲目数量超出上限（${MAX_BURN_TRACKS}）` }

  const tracks: Track[] = []
  for (const raw of rawTracks) {
    if (typeof raw !== 'object' || raw === null)
      return { ok: false, error: '曲目格式错误' }
    const t = raw as Record<string, unknown>
    if (typeof t.id !== 'string' || !t.id || t.id.length > MAX_TEXT_LEN)
      return { ok: false, error: '曲目 ID 非法' }
    if (!isMusicSource(t.source)) return { ok: false, error: '未知音源' }
    for (const field of ['title', 'artist', 'album'] as const) {
      if (typeof t[field] !== 'string' || t[field].length > MAX_TEXT_LEN)
        return { ok: false, error: `曲目字段 ${field} 非法` }
    }
    if (typeof t.duration !== 'number' || !Number.isFinite(t.duration))
      return { ok: false, error: '曲目时长非法' }
    tracks.push(t as unknown as Track)
  }

  const sources = new Set(tracks.map((t) => t.source))
  if (sources.size > 1)
    return { ok: false, error: '曲目跨多个音源，无法直刻（可改用数字分发）' }

  const rawMeta = b.meta
  if (typeof rawMeta !== 'object' || rawMeta === null)
    return { ok: false, error: '缺少合集元信息' }
  const m = rawMeta as Record<string, unknown>
  if (typeof m.name !== 'string' || !m.name.trim())
    return { ok: false, error: '合集名称为空' }
  if (m.name.length > MAX_TEXT_LEN) return { ok: false, error: '合集名称过长' }
  const kind = m.kind
  if (kind !== 'playlist' && kind !== 'album' && kind !== 'favorites')
    return { ok: false, error: '未知的合集类型' }

  if (discType === 'audio') {
    const total = tracks.reduce(
      (sum, t) => sum + (t.duration > 0 ? t.duration : 0),
      0,
    )
    if (!audioCdFitsTotal(total, tracks.length))
      return {
        ok: false,
        error: `总时长约 ${Math.ceil(total / 60)} 分钟，超出音频 CD 上限（约 ${Math.round(AUDIO_CD_MAX_SECONDS / 60)} 分钟）`,
      }
  }

  return {
    ok: true,
    value: {
      meta: {
        distribution: 'physical',
        discType,
        kind,
        name: m.name.trim(),
        source: sources.values().next().value as MusicSource,
        sourceId: typeof m.sourceId === 'string' ? m.sourceId : undefined,
        creator: typeof m.creator === 'string' ? m.creator : undefined,
        coverUrl: typeof m.coverUrl === 'string' ? m.coverUrl : undefined,
        level: b.level,
      },
      tracks,
      discType,
      level: b.level,
    },
  }
}

/**
 * 清洗卷标：ISO9660 只接受 `A-Z 0-9 _ .`（FileSystemsToCreate 含 ISO9660 档），
 * 故统一大写、剥除非白名单字符、限长 32；清洗后为空回落 `PTEROSAUR`。
 */
export function sanitizeVolumeLabel(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 32)
    .trim()
  return cleaned || 'PTEROSAUR'
}

/**
 * 封面 URL 白名单（防 SSRF）：仅 https 且主机属网易云图片 CDN（`*.music.126.net`）
 * 或 B 站 CDN（`*.hdslb.com`）；不合法即丢弃封面（不 fail 整个任务）。
 */
export function isAllowedCoverUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return /(^|\.)music\.126\.net$/.test(host) || /(^|\.)hdslb\.com$/.test(host)
  } catch {
    return false
  }
}

/* ============================ 能力探测（capabilities） ============================ */

/** 能力探测缓存 TTL：对话框打开时拉取；短 TTL 兼顾「换盘后重新检测」。 */
const CAPS_TTL_MS = 5_000
let capsCache: { at: number; value: RipCapabilities } | null = null

export async function ripCapabilities(): Promise<RipCapabilities> {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS)
    return capsCache.value

  const platform = process.platform
  const simulated = isFakeBurn()
  const bin = await resolveFfmpegPath()
  const ffmpeg = bin
    ? { available: true, version: (await ffmpegVersion(bin)) ?? undefined }
    : { available: false }
  const audioCd = { maxSeconds: AUDIO_CD_MAX_SECONDS }

  let value: RipCapabilities
  if (platform !== 'win32' && !simulated) {
    value = {
      platform,
      simulated,
      supported: false,
      reason: '当前平台不支持直刻（仅 Windows）',
      recorders: [],
      media: { present: false, blank: false },
      ffmpeg,
      audioCd,
    }
  } else {
    try {
      const probe = await probeDisc()
      value = {
        platform,
        simulated: probe.simulated,
        supported: true,
        recorders: probe.recorders,
        media: {
          present: probe.mediaPresent,
          blank: probe.blank,
          profile: probe.profile,
          capacityBytes: probe.capacityBytes,
          dataSupported: probe.dataSupported,
          audioSupported: probe.audioSupported,
        },
        ffmpeg,
        audioCd,
      }
    } catch (e) {
      value = {
        platform,
        simulated,
        supported: false,
        reason: e instanceof Error ? e.message : '刻录能力探测失败',
        recorders: [],
        media: { present: false, blank: false },
        ffmpeg,
        audioCd,
      }
    }
  }
  capsCache = { at: Date.now(), value }
  return value
}

/* ============================ 任务执行 ============================ */

export interface RunBurnInput {
  meta: RipMetaInput
  tracks: Track[]
  discType: DiscType
  level: AudioLevel
  /** 服务端内容凭证（访客会话 ?? 缺省凭证），由路由解析传入。 */
  credential?: string
}

/**
 * 发起一次刻录（**立即返回**，任务后台执行；进度经 {@link subscribeRip} 广播）。
 * 已有任务在跑时返回 `{ busy: true }`（路由回 409）。
 */
export function startBurn(
  input: RunBurnInput,
): { id: string } | { busy: true } {
  if (job) return { busy: true }
  const id = `burn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  job = {
    id,
    phase: 'fetch',
    current: 0,
    total: input.tracks.length,
    percent: null,
    discType: input.discType,
    startedAt: Date.now(),
  }
  void (async () => {
    try {
      await runJob(input)
    } finally {
      job = null
    }
  })()
  return { id }
}

/** 封面下载体积上限（COVER_RIP=3000 母带通常 1–2MB，30MB 已极宽裕）。 */
const COVER_MAX_BYTES = 30 * 1024 * 1024
const COVER_TIMEOUT_MS = 10_000

/**
 * 模拟模式（`PTEROSAUR_RIP_FAKE_BURN=1`）下替代真实取流的**合成音频**：
 * 0.1s 44.1kHz/16bit 立体声静音 WAV——是**真实可转码**的合法 PCM，
 * 故音频 CD 的模拟链路仍会经过真实 ffmpeg；数据 CD 直接上盘。
 */
const FAKE_AUDIO_WAV: Buffer = (() => {
  const dataBytes = 17640 // 0.1s × 44100Hz × 2ch × 2bytes
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(2, 22) // 立体声
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(44100 * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf
})()

async function runJob(input: RunBurnInput): Promise<void> {
  let stagingRoot: string | null = null
  try {
    stagingRoot = await mkdtemp(join(tmpdir(), 'pterosaur-burn-'))
    const discDir = join(stagingRoot, 'disc')

    // 1) 先探测刻录机与介质：无盘 / 不可写 / 目标格式不受支持立即失败（在拉取任何音频之前）
    const probe = await probeDisc()
    if (probe.recorders.length === 0)
      throw new Error(psErrorMessage('no_recorder'))
    if (!probe.mediaPresent) throw new Error(psErrorMessage('no_media'))
    if (!probe.blank) throw new Error(psErrorMessage('media_not_blank'))
    if (input.discType === 'data' && !probe.dataSupported)
      throw new Error(psErrorMessage('media_unsupported_data', probe.profile))
    if (input.discType === 'audio' && !probe.audioSupported)
      throw new Error(psErrorMessage('media_unsupported_audio', probe.profile))

    // 2) 逐轨拉取落盘（流式写入；单轨失败 fail-fast——半成品刻进盘不可挽回）。
    //    模拟模式下取流一并模拟（合成 WAV），使全链路演练 / E2E 完全封闭。
    const fake = isFakeBurn()
    const adapter = fake ? undefined : adapterOf(input.tracks[0].source)
    if (!fake && !adapter) throw new Error('未知音源')

    await mkdir(discDir, { recursive: true })
    const files = new Map<number, string>()
    let totalBytes = 0
    for (let i = 0; i < input.tracks.length; i++) {
      const t = input.tracks[i]
      let ext: string
      const destOf = (e: string) =>
        join(discDir, ripFileName(i + 1, input.tracks.length, t.title, e))

      if (fake) {
        ext = 'wav'
      } else {
        const urls = await adapter!.songUrl(t.id, input.credential, input.level)
        if (!urls.length)
          throw new Error(
            `「${t.title}」不可获取（VIP / 版权受限）；请检查服务端凭证（pnpm log-in）`,
          )
        const fetched = await fetchAudioCandidate(urls, {
          'User-Agent': UA,
          ...adapter!.streamHeaders?.(t.id),
        })
        if (!fetched) throw new Error(`「${t.title}」音频源不可用`)
        ext = extFromMime(
          audioContentTypeFromUrl(fetched.usedUrl) ??
            fetched.res.headers.get('content-type'),
        )
        await pipeline(
          Readable.fromWeb(
            fetched.res
              .body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
          ),
          createWriteStream(destOf(ext)),
        )
      }

      if (fake) await writeFile(destOf(ext), FAKE_AUDIO_WAV)
      files.set(i + 1, basename(destOf(ext)))

      // 数据 CD：累计落盘字节守护介质容量（超出即中止，写入前发现）
      if (input.discType === 'data' && probe.capacityBytes) {
        totalBytes += (await stat(destOf(ext))).size
        if (totalBytes > probe.capacityBytes)
          throw new Error('刻录内容超出光盘容量（约 700MB），请减少曲目')
      }

      emitProgress('fetch', i + 1, input.tracks.length)
    }

    // 3) 音频 CD：逐轨转码为 CD-DA 规格**裸 PCM**（44.1kHz/16bit 立体声，无 RIFF 头——
    //    DiscAtOnce 镜像的 AddTrack 按 2352 字节/扇区消费裸 PCM，见 ADR-048）
    const audioTracks: string[] | undefined = []
    if (input.discType === 'audio') {
      const bin = await resolveFfmpegPath()
      if (!bin)
        throw new Error(
          '未找到可用的 ffmpeg，无法转码音频 CD（可设 PTEROSAUR_FFMPEG_PATH）',
        )
      const pcmDir = join(stagingRoot, 'pcm')
      await mkdir(pcmDir, { recursive: true })
      emitProgress('convert', 0, input.tracks.length)
      for (let i = 0; i < input.tracks.length; i++) {
        const t = input.tracks[i]
        const src = join(discDir, files.get(i + 1)!)
        const pcm = join(
          pcmDir,
          ripFileName(i + 1, input.tracks.length, t.title, 'pcm'),
        )
        await toCdPcm(bin, src, pcm)
        // CD-DA 帧定长：元数据时长的亚秒偏差会让尾帧不足，补零对齐到扇区边界
        await padToCdSector(pcm)
        audioTracks.push(pcm)
        emitProgress('convert', i + 1, input.tracks.length)
      }
    }

    // 4) 生成元信息：数据 CD 与封面一并上盘；音频 CD 无文件系统，meta 仅随浏览器下载
    let meta: RipMeta
    if (input.discType === 'data') {
      let coverFile: string | undefined
      if (input.meta.coverUrl && isAllowedCoverUrl(input.meta.coverUrl)) {
        coverFile =
          (await fetchCover(input.meta.coverUrl, discDir)) ?? undefined
      }
      meta = buildRipMeta(input.meta, input.tracks, {
        fileOf: (index) => files.get(index),
        coverFile,
      })
      await writeFile(
        join(discDir, RIP_META_FILE),
        JSON.stringify(meta, null, 2),
        'utf8',
      )
    } else {
      meta = buildRipMeta(input.meta, input.tracks, {})
    }

    // 5) 写盘（burn 阶段无真实百分比——IMAPI 不可得，见 ADR-048）
    emitProgress('burn', 0, 1, null)
    await burnDisc(
      {
        mode: input.discType,
        stagingDir: discDir,
        volumeLabel: sanitizeVolumeLabel(input.meta.name),
        audioTracks: input.discType === 'audio' ? audioTracks : undefined,
      },
      () => {
        /* 细粒度事件保留给日志层；进度按阶段粒度广播即可 */
      },
    )

    lastResult = {
      value: { status: 'done', meta, at: Date.now() },
      expiresAt: Date.now() + LAST_RESULT_TTL_MS,
    }
    broadcastRip({ type: 'done', meta })
  } catch (err) {
    const message = err instanceof Error ? err.message : '刻录失败'
    lastResult = {
      value: { status: 'error', error: message, at: Date.now() },
      expiresAt: Date.now() + LAST_RESULT_TTL_MS,
    }
    broadcastRip({ type: 'error', phase: job?.phase ?? 'fetch', message })
  } finally {
    if (stagingRoot)
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

/** 服务端拉取封面（白名单已由调用方先行校验）；失败返回 null。 */
async function fetchCover(
  url: string,
  destDir: string,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type')
    if (!type?.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > COVER_MAX_BYTES) return null
    const name = `cover.${extFromImageMime(type)}`
    await writeFile(join(destDir, name), buf)
    return name
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* ============================ 启动清扫 ============================ */

/**
 * 清扫 `os.tmpdir()` 下超过 `maxAgeMs` 的刻录暂存目录（进程崩溃 / 强杀后的残留）。
 * best-effort：任何失败静默忽略。
 */
export async function sweepStaleBurnDirs(
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true })
    const now = Date.now()
    for (const e of entries) {
      if (!e.name.startsWith('pterosaur-burn-')) continue
      const p = join(tmpdir(), e.name)
      try {
        const st = await stat(p)
        if (now - st.mtimeMs > maxAgeMs)
          await rm(p, { recursive: true, force: true })
      } catch {
        /* 单个目录失败忽略 */
      }
    }
  } catch {
    /* tmpdir 不可读：忽略 */
  }
}

/* ============================ 测试辅助 ============================ */

/** 重置模块级状态（单测用）。 */
export function _resetRipForTest(): void {
  job = null
  lastResult = null
  capsCache = null
  listeners.clear()
}
