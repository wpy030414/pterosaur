/**
 * 翻录（合集打包下载）的**分发与元信息**共享定义。
 *
 * 翻录存在两条分发通道（见 ADR-047）：
 * - `digital`：浏览器 JSZip 打包下载，`meta.json` 随包写入；
 * - `physical`：后端**直刻本机光驱**（仅同机访问开放），数据 CD 将 `meta.json` 一并上盘，
 *   音频 CD（标准 CD-DA）完成后由浏览器下载一份 `meta.json`。
 *
 * 本模块是两端产物的**单一事实来源**：文件名清洗、`meta.json` 构建、容量判定与
 * loopback 判定都在这里；不引入任何运行环境相关代码（浏览器 / Node 均可引用）。
 */
import type { AudioLevel, MusicSource, Track } from './types.js'

/** 翻录产物中元信息文件的固定名（zip 根 / 光盘根 / 浏览器下载名）。 */
export const RIP_META_FILE = 'meta.json'

/** `meta.json` 的 schema 标识（未来不兼容变更时递增 @ 后缀）。 */
export const RIP_META_SCHEMA = 'pterosaur-rip@1'

/**
 * 音频 CD 的**保守**总时长上限（秒）。
 *
 * 标准 80 分钟盘的名义容量约 4800 秒，这里留到 79 分钟再扣轨间 gap——
 * 转码后每轨以 44.1kHz/16bit 立体声写入，不同刻录机对 lead-in/lead-out 的
 * 占用略有差异，宁可少刻不可刻废（废盘不可逆）。
 */
export const AUDIO_CD_MAX_SECONDS = 79 * 60

/** 音频 CD 每轨预留的轨间 gap（秒）；容量判定必须计入。 */
export const AUDIO_CD_TRACK_GAP_SECONDS = 2

/** 分发方式：后续数字分发（打包下载）或实体分发（直刻光盘）。 */
export type RipDistribution = 'digital' | 'physical'

/** 光盘类型：数据 CD（文件原样上盘）或音频 CD（CD-DA，需转 44.1kHz/16bit PCM）。 */
export type DiscType = 'data' | 'audio'

/** 翻录合集类型（`meta.json` 的 `kind` 字段）。 */
export type RipKind = 'playlist' | 'album' | 'favorites'

/** 翻录任务的阶段：拉取音频 → （音频 CD）转码 → 刻录。 */
export type RipPhase = 'fetch' | 'convert' | 'burn'

/** `meta.json` 中的单曲条目。 */
export interface RipMetaTrack {
  /** 序号（从 1 起，与文件名前缀一致）。 */
  index: number
  source: MusicSource
  id: string
  title: string
  artist: string
  album: string
  /** 时长（秒）；未知为 0。 */
  duration: number
  fee: Track['fee']
  /**
   * 产物中的音频文件名（如 `01 - 曲名.flac`）。
   * **音频 CD 缺省**——CD-DA 的轨没有文件系统，仅以轨序对应。
   */
  file?: string
}

/** 翻录产物的元信息（写入 `meta.json`）。 */
export interface RipMeta {
  schema: typeof RIP_META_SCHEMA
  /** 生成时刻（ISO 8601）。 */
  generatedAt: string
  distribution: RipDistribution
  /** 仅实体分发：光盘类型。 */
  discType?: DiscType
  kind: RipKind
  name: string
  /** 合集所属源（音源 / 磁带渠道）；**跨源合集**（如混合收藏）缺省。 */
  source?: MusicSource
  /** 源内合集 id（`favorites` 无）。 */
  sourceId?: string
  /** 合集创建者（歌单作者 / 专辑艺人由 tracks 承载，磁带为 UP 主）。 */
  creator?: string
  /** 封面文件信息；未获取到封面时缺省。 */
  cover?: { file: string; url: string }
  trackCount: number
  /** 全部曲目时长合计（秒）。 */
  totalDuration: number
  /** 本次翻录所用音质档位（整体一致）。 */
  level: AudioLevel
  tracks: RipMetaTrack[]
  /** 拉取失败的曲目（仅数字分发可能非空：单首失败跳过，不阻断整包）。 */
  skipped?: { index: number; title: string; reason: string }[]
}

/** 构建 `meta.json` 的输入（随请求 / 调用透传的合集描述）。 */
export interface RipMetaInput {
  distribution: RipDistribution
  /** 仅实体分发：光盘类型。 */
  discType?: DiscType
  kind: RipKind
  name: string
  /** 合集所属源；跨源合集（如混合收藏）缺省。 */
  source?: MusicSource
  sourceId?: string
  creator?: string
  /** 封面原始地址（已规范化）；是否真正入包由调用方依获取结果决定。 */
  coverUrl?: string
  level: AudioLevel
}

/** {@link buildRipMeta} 的可选项。 */
export interface RipMetaBuildOptions {
  /** 注入生成时刻（测试用）；缺省取当前时间。 */
  generatedAt?: string
  /** 回填某曲目在产物中的实际文件名（按 1 起的序号查询）。 */
  fileOf?: (index: number, track: Track) => string | undefined
  /** 实际获取成功的封面文件名（如 `cover.jpg`）；缺省则不带 cover。 */
  coverFile?: string
  /** 数字分发时被跳过的曲目。 */
  skipped?: RipMeta['skipped']
}

/** 由输入与曲目列表构建 `meta.json` 对象（前后端**同一实现**，保证 schema 不漂移）。 */
export function buildRipMeta(
  input: RipMetaInput,
  tracks: Track[],
  opts: RipMetaBuildOptions = {},
): RipMeta {
  const metaTracks: RipMetaTrack[] = tracks.map((t, i) => {
    const index = i + 1
    return {
      index,
      source: t.source,
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
      fee: t.fee,
      file: opts.fileOf?.(index, t),
    }
  })
  return {
    schema: RIP_META_SCHEMA,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    distribution: input.distribution,
    discType: input.discType,
    kind: input.kind,
    name: input.name,
    source: input.source,
    sourceId: input.sourceId,
    creator: input.creator,
    cover:
      input.coverUrl && opts.coverFile
        ? { file: opts.coverFile, url: input.coverUrl }
        : undefined,
    trackCount: tracks.length,
    totalDuration: tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
    level: input.level,
    tracks: metaTracks,
    skipped: opts.skipped?.length ? opts.skipped : undefined,
  }
}

/**
 * 音频 CD 容量判定：`Σ时长 + 2s × 曲数 ≤ 79 分钟`。
 *
 * 超限**拒绝**（不做分盘，见 ADR-048）；调用方负责把实际分钟数写进拒绝文案。
 * 非法时长（NaN / 负值）按 0 计，宁可放行后再由刻录端兜底。
 */
export function audioCdFits(durations: number[]): boolean {
  const total = durations.reduce(
    (sum, d) => sum + (Number.isFinite(d) && d > 0 ? d : 0),
    0,
  )
  return audioCdFitsTotal(total, durations.length)
}

/**
 * 由「总时长 + 曲数」直接判定音频 CD 容量。
 * 翻录对话框只有合集级汇总（无逐曲时长数组），走此入口保持与 {@link audioCdFits} 同一口径。
 */
export function audioCdFitsTotal(
  totalDuration: number,
  trackCount: number,
): boolean {
  const total =
    Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : 0
  return total + AUDIO_CD_TRACK_GAP_SECONDS * trackCount <= AUDIO_CD_MAX_SECONDS
}

/**
 * 判定访问主机是否**回环地址**（浏览器与后端同机）。
 *
 * 实体分发（直刻）仅在此条件下开放：直刻写入的是**后端所在设备**的光驱，
 * 浏览器在远端时既无意义也不安全。前端以 `location.hostname` 判定（主门控），
 * 后端以连接的对端地址判定（`::ffff:` IPv4 映射一并接受）；两侧共用本函数保证口径一致。
 *
 * 接受：`localhost`、`127.x.y.z`、`::1`、`[::1]`、`::ffff:127.x.y.z`。
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h === 'localhost' || h === '::1') return true
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length)
  return /^127(?:\.\d{1,3}){3}$/.test(h)
}

/**
 * 将标题 / 合集名清洗为安全的文件名片段。
 *
 * 两端共用（防路径穿越：去路径分隔符与控制字符）；同时兜底 Windows 非法字符、
 * 折叠空白、限制长度（80 字符，按码点切防拆代理对）、去尾部 `.` 与空格。
 */
export function safeRipName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const limited = [...cleaned].slice(0, 80).join('').replace(/[. ]+$/, '')
  return limited || 'track'
}

/**
 * 构造产物中的音频文件名：`01 - 曲名.ext`（序号按总曲数补零，保证字典序 = 曲序）。
 * 与既有 zip 打包行为一致。
 */
export function ripFileName(
  index: number,
  total: number,
  title: string,
  ext: string,
): string {
  const digits = String(Math.max(total, 1)).length
  const num = String(index).padStart(digits, '0')
  return `${num} - ${safeRipName(title)}.${ext}`
}

/** 根据音频 Content-Type 推断文件扩展名，默认 mp3。 */
export function extFromMime(mime: string | null): string {
  if (!mime) return 'mp3'
  const m = mime.toLowerCase()
  if (m.includes('flac')) return 'flac'
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('aac') || m.includes('mp4') || m.includes('m4a')) return 'm4a'
  return 'mp3'
}

/** 根据图片 Content-Type 推断扩展名，默认 jpg。 */
export function extFromImageMime(mime: string | null): string {
  const m = (mime ?? '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('avif')) return 'avif'
  if (m.includes('bmp')) return 'bmp'
  return 'jpg'
}

/* ============================ 直刻协议（前后端共用） ============================ */

/** 后端直刻能力快照（`GET /api/rip/capabilities`，仅同机可查）。 */
export interface RipCapabilities {
  /** `process.platform`。 */
  platform: string
  /** 是否为模拟刻录（开发 / 测试的 `PTEROSAUR_RIP_FAKE_BURN`）。 */
  simulated: boolean
  /** 当前平台 / 环境是否支持直刻（非 Windows 为 false）。 */
  supported: boolean
  /** 不支持时的原因文案。 */
  reason?: string
  /** 已连接的刻录机。 */
  recorders: { id: string; product?: string }[]
  /** 当前已就绪介质的状态（取第一台刻录机）。 */
  media: {
    present: boolean
    /** 是否为空白 / 可追加介质（可刻录的前提）。 */
    blank: boolean
    /** 介质配置，如 `CD-R` / `CD-RW` / `DVD-R`。 */
    profile?: string
    /** 介质总容量（字节）。 */
    capacityBytes?: number
  }
  /** 静态集成的 ffmpeg 可用性（音频 CD 转码依赖）。 */
  ffmpeg: { available: boolean; version?: string }
  /** 音频 CD 容量上限（秒），取自 {@link AUDIO_CD_MAX_SECONDS}。 */
  audioCd: { maxSeconds: number }
}

/** 用户在翻录对话框中的选择结果。 */
export type RipChoice =
  | { distribution: 'digital' }
  | { distribution: 'physical'; discType: DiscType }

/** 进行中任务的快照（SSE 首帧 / `GET /api/rip/status`）。 */
export interface RipJobSnapshot {
  jobId: string
  phase: RipPhase
  current: number
  total: number
  /** 进度百分比；**刻录阶段恒为 null**（IMAPI 拿不到真实百分比，前端渲染不确定进度）。 */
  percent: number | null
  discType?: DiscType
  startedAt: number
}

/** 最近一次任务的终态（任务结束后保留约 60s，供 SSE 竞态 / 重连回放）。 */
export interface RipLastResult {
  status: 'done' | 'error'
  /** 成功时携带完整 `meta.json` 对象。 */
  meta?: RipMeta
  error?: string
  at: number
}

/** SSE 事件载荷（`GET /api/rip/events`）。 */
export type RipEvent =
  /** 连接建立时的快照帧：当前任务与最近的终态。 */
  | { type: 'state'; job: RipJobSnapshot | null; last: RipLastResult | null }
  | {
      type: 'progress'
      phase: RipPhase
      current: number
      total: number
      percent: number | null
    }
  | { type: 'done'; meta: RipMeta }
  | { type: 'error'; phase: RipPhase; message: string }

/** `POST /api/rip/burn` 的请求体。 */
export interface RipBurnRequestBody {
  /** 合集描述（`discType` 以请求体的独立字段为准，服务端会回填进 meta）。 */
  meta: RipMetaInput
  tracks: Track[]
  discType: DiscType
  level: AudioLevel
}
