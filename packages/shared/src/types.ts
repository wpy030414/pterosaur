/**
 * 前后端共享的类型定义与常量。
 *
 * 该文件同时被 `src/`（浏览器）与 `server/`（Node）引用，
 * 因此不得包含任何运行环境相关的代码（如 DOM / Node API）。
 */

/** 可浏览的音乐音源（顺序即 UI 展示顺序：网易云优先）。 */
export const MUSIC_SOURCES = ['netease'] as const

/**
 * MV 渠道：只提供「搜视频 + 播放其音频」（B 站 DASH 分轨，只取音频）。
 *
 * 作为**独立渠道**存在，故刻意**不放进 {@link MUSIC_SOURCES}**——否则 `activeSource`
 * 会在登录后返回它，把首页 / 浏览 / 发现的「活动源」带偏。登录态与单活动账号模型也互不干扰。
 */
export const MV_SOURCES = ['bilibili'] as const

/** 全部音源（音乐音源 + MV 渠道）；`Track.source` 等实体字段的取值范围。 */
export const ALL_SOURCES = [...MUSIC_SOURCES, ...MV_SOURCES] as const

/** 音源服务器。 */
export type MusicSource = (typeof ALL_SOURCES)[number]

/** 缺省音源：旧数据回填、URL 缺源段时的兜底。 */
export const DEFAULT_SOURCE: MusicSource = 'netease'

/**
 * 判定是否合法音源。用于 `:source` 路由段守卫——
 * 本地自建歌单 id 形如 `pl-xxx`，须确保不被误判为源。
 */
export function isMusicSource(v: unknown): v is MusicSource {
  return typeof v === 'string' && (ALL_SOURCES as readonly string[]).includes(v)
}

/** 读取实体所属源；旧持久化数据（收藏 / 最近 / 队列 / 云同步载荷）缺失时回填缺省源。 */
export function sourceOf(e: { source?: MusicSource }): MusicSource {
  return e.source ?? DEFAULT_SOURCE
}

/**
 * 跨源稳定身份键：`<source>:<id>`。
 * 全仓所有「认曲 / 认实体」的比对（收藏去重、队列定位、缓存键前缀）一律用它，
 * 避免不同源的曲目共享同一原始 id 时互相覆盖。
 */
export function keyOf(e: { id: string; source?: MusicSource }): string {
  return `${sourceOf(e)}:${e.id}`
}

/** 播放循环模式。 */
export type RepeatMode = 'off' | 'all' | 'one'

/** 曲目内联的艺人引用（含 id，供跳转艺人页）。 */
export interface ArtistRef {
  id: string
  name: string
}

/** 精简后的曲目模型，前后端统一使用该结构。 */
export interface Track {
  /** 所属音源。与 `id` 共同构成跨源唯一身份（见 `keyOf`）。 */
  source: MusicSource
  /** 曲目在音源内的唯一 ID。 */
  id: string
  /** 曲名。 */
  title: string
  /** 主艺人（多艺人以 `/` 连接）。 */
  artist: string
  /** 专辑名。 */
  album: string
  /** 封面地址（已改写为 https）。 */
  cover: string
  /** 时长（秒）。未知时为 0。 */
  duration: number
  /**
   * 版权标记：`free` 免费可听、`vip` 需会员、`unknown` 未知。
   * 由后端根据网易云 `fee` 字段推断，仅用于 UI 提示，最终能否播放以实际解析为准。
   */
  fee: 'free' | 'vip' | 'unknown'
  /**
   * 该曲目关联的艺人引用（含 id），供界面逐个跳转艺人页。
   * 旧的持久化数据（收藏 / 最近播放 / 队列）可能缺失，缺失时界面降级为纯文本。
   */
  artistRefs?: ArtistRef[]
  /** 所属专辑 id，供界面跳转专辑页。旧数据可能缺失。 */
  albumId?: string
}

/** 艺人模型。 */
export interface Artist {
  /** 所属音源。 */
  source: MusicSource
  id: string
  name: string
  /** 头像地址（已改写为 https）。 */
  avatar: string
  /** 别名列表。 */
  alias?: string[]
  /** 专辑数量。 */
  albumSize?: number
  /** 单曲数量。 */
  musicSize?: number
  /** 简介。 */
  briefDesc?: string
}

/** 专辑模型。 */
export interface Album {
  /** 所属音源。 */
  source: MusicSource
  id: string
  name: string
  /** 封面地址（已改写为 https）。 */
  cover: string
  /** 艺人名（多艺人以 `/` 连接）。 */
  artist: string
  /** 主艺人 id，供跳转艺人页。 */
  artistId?: string
  /** 发行年份。 */
  year?: number
  /** 曲目数量。 */
  trackCount?: number
}

/** 多类型搜索结果（歌曲 / 艺人 / 专辑 / 歌单）。 */
export interface SearchResults {
  songs: Track[]
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  /**
   * 各类型在**当前源**下是否受支持（缺失视为支持）。
   * 某些源可能不具备全部搜索能力（如某源暂不支持歌单搜索），供 UI 隐藏不支持的分类。
   */
  capabilities?: Record<'songs' | 'artists' | 'albums' | 'playlists', boolean>
}

/** 歌单 / 排行榜等合集的精简模型。 */
export interface Playlist {
  /** 所属音源。 */
  source: MusicSource
  id: string
  name: string
  cover: string
  /** 简介。 */
  description?: string
  /** 曲目数量。 */
  trackCount?: number
  /** 播放量（若有）。 */
  playCount?: number
  /** 创建者昵称。 */
  creator?: string
}

/** 用户自建歌单（本地存储，不含曲目正文，仅存曲目引用）。 */
export interface LocalPlaylist {
  id: string
  name: string
  /** 创建时间戳。 */
  createdAt: number
  /** 曲目列表（完整 Track，便于离线展示）。 */
  tracks: Track[]
}

/**
 * 资料库的可同步数据（收藏 / 最近 / 自建歌单 / 收藏的网易云歌单 · 艺人 · 专辑）。
 * 与前端 `store/library.ts` 的持久化字段一一对应，也是云同步的载荷。
 */
export interface LibraryData {
  /** 收藏（我喜欢）的曲目。 */
  favorites: Track[]
  /** 最近播放（去重，最多 100 条）。 */
  recent: Track[]
  /** 本地自建歌单。 */
  playlists: LocalPlaylist[]
  /** 收藏的网易云歌单引用。 */
  savedPlaylists: Playlist[]
  /** 收藏的网易云艺人引用。 */
  savedArtists: Artist[]
  /** 收藏的网易云专辑引用。 */
  savedAlbums: Album[]
}

/**
 * 云同步封套：一份完整 library + 修改时间戳。
 * 冲突策略为 LWW（最新修改为准），故仅需单个 `updatedAt`。
 */
export interface SyncEnvelope {
  state: LibraryData
  updatedAt: number
}

/** 一行歌词。 */
export interface LyricLine {
  /** 起始时间（秒）。 */
  time: number
  /** 主歌词文本。 */
  text: string
  /** 翻译（若有）。 */
  translation?: string
}

/** 歌词解析结果。 */
export interface Lyric {
  lines: LyricLine[]
  /** 是否含时间轴（否则为纯文本歌词）。 */
  timed: boolean
}

/** 统一的后端响应包裹。 */
export interface ApiResult<T> {
  ok: boolean
  data?: T
  /** 失败时的错误信息。 */
  error?: string
  /** 需要登录（VIP 曲目未登录等）。 */
  needLogin?: boolean
}

/** 登录状态。 */
export interface LoginStatus {
  logged: boolean
  nickname?: string
  avatarUrl?: string
  /**
   * 账号 ID（用于云同步锚点与拉取「我的歌单」）。
   * 用**字符串**：部分平台的账号 id 会超出 JS 安全整数范围，数字承载会丢精度。
   */
  userId?: string
  /** 是否 VIP。 */
  vip?: boolean
  /**
   * 该源是否**支持登录**（= 适配器是否实现了扫码能力）。
   * 缺省视为支持；显式 `false` 表示该源没有登录入口，
   * 前端据此隐藏登录 UI 与「登录解锁」引导。
   */
  loginable?: boolean
}

/** 后端 API 基础路径前缀。 */
export const API_BASE = '/api'

/** 音频流代理路径前缀。 */
export const STREAM_BASE = '/stream'

/* ============================ 音质档位 ============================ */

/**
 * 统一抽象音质档位（跨源一致，从低到高）。
 *
 * 档名沿用网易云 `song_url_v1` 的 level 取值，网易云侧**零映射**；
 * 其它源由各自适配器映射到其原生档位。
 */
export const AUDIO_LEVELS = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
] as const

/** 抽象音质档位。 */
export type AudioLevel = (typeof AUDIO_LEVELS)[number]

/** 缺省档位（与后端 `/stream` 默认一致）。 */
export const DEFAULT_AUDIO_LEVEL: AudioLevel = 'exhigh'

/** 档位高低序（数值越大越高），供「不可得时逐级降级」判断。 */
export const AUDIO_LEVEL_RANK: Record<AudioLevel, number> = {
  standard: 0,
  higher: 1,
  exhigh: 2,
  lossless: 3,
  hires: 4,
}

/** 判定是否合法档位（用于 query 等不可信输入）。 */
export function isAudioLevel(v: unknown): v is AudioLevel {
  return (
    typeof v === 'string' && (AUDIO_LEVELS as readonly string[]).includes(v)
  )
}

/** 归一化档位：非法或缺失时回退缺省档。 */
export function audioLevelOrDefault(v: unknown): AudioLevel {
  return isAudioLevel(v) ? v : DEFAULT_AUDIO_LEVEL
}

/**
 * 由「源 + 曲目 ID」构造同源音频流地址。
 *
 * 浏览器 `<audio>` 直接请求该地址，后端按源分发、解析真实 URL、
 * 改写为 https 并支持 Range 分段，从而规避混合内容与跨域问题。
 */
export function streamUrl(
  source: MusicSource,
  id: string,
  opts?: { level?: AudioLevel; token?: string },
): string {
  const q = new URLSearchParams()
  if (opts?.level) q.set('level', opts.level)
  if (opts?.token) q.set('t', opts.token)
  const qs = q.toString()
  return `${STREAM_BASE}/${source}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`
}

/** 便捷式：由曲目构造同源音频流地址（`source` 缺失时按缺省源）。 */
export function streamUrlOf(
  track: Track,
  opts?: { level?: AudioLevel; token?: string },
): string {
  return streamUrl(sourceOf(track), track.id, opts)
}

/**
 * 将秒数格式化为 `m:ss`；满 1 小时换算为 `h:mm:ss`（分钟与秒补零两位）。
 * B 站视频动辄数小时，只用分钟标记（如 `185:05`）不可读。
 */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s - h * 3600) / 60)
  const ss = s - h * 3600 - m * 60
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}
