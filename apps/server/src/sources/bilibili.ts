/**
 * B 站（哔哩哔哩）音源适配器 —— 「MV」渠道。
 *
 * 定位：**只用于搜索视频并播放其音频**。B 站是 DASH 音视频分轨，取 `dash.audio` 即可，
 * 无需解析视频。它不是可浏览音源，故不在 `MUSIC_SOURCES` 中（见 shared/types 的 `MV_SOURCES`）；
 * `playlistTracks` / 发现类能力一律不实现（路由回 501）。
 *
 * 反爬要点（2026-10 实测）：
 * - 搜索走 `x/web-interface/search/all/v2`（**未被风控**；`x/web-interface/wbi/search/type`
 *   会回 `v_voucher` 人机验证，弃用）；
 * - 取音频：`x/player/pagelist?bvid=` 取 cid → `x/player/playurl?...&fnval=16` 取 `dash.audio`；
 * - 音频直链（`*.bilivideo.*` / `*.mcdn.bilivideo.cn`）取字节**必须带 `Referer: https://www.bilibili.com`**；
 * - 匿名即可拿到 `dash.audio`（实测最高 ~204kbps）；带 SESSDATA（登录后）可提升码率与稳定性。
 * - 字幕（作歌词，ADR-035）：`x/player/wbi/v2`（**wbi 签名**）取轨列表、`subtitle_url` 指向的
 *   JSON 即正文；**未登录 `subtitles` 恒空**（实测 wbi 签名也救不了）——与网页端未登录看不到
 *   CC 一致，登录或服务端缺省凭证（`BILIBILI_COOKIE`）后可见（含 AI 字幕）。
 *   双语模式（原文为主、中文为译；AI 轨正确归类、人工优先）与实证采样见 ADR-035。
 */
import { createHash } from 'node:crypto'
import QRCode from 'qrcode'
import {
  DEFAULT_AUDIO_LEVEL,
  type Album,
  type AudioLevel,
  type LoginStatus,
  type Lyric,
  type LyricLine,
  type Track,
} from '@pterosaur/shared/types'
import type { QrCheckResult, SourceAdapter } from './types.js'

/** 浏览器 UA（B 站对非浏览器 UA 较敏感）。 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 调接口 / 取字节必需的上游来源页（否则直链 403）。 */
const REFERER = 'https://www.bilibili.com'

/** B 站图片固定镜像主机（i0–iN.hdslb.com 互为镜像，规范化以免缓存碎片，类比 ADR-020）。 */
const BILI_IMAGE_HOST = 'i0.hdslb.com'

/**
 * 会话必需 cookie 名单：登录态透传与登出清理**共用同一份**——
 * 若登出漏清任一项，残留项会让后端 `cookieOf` 返回非空、绕开缺省凭证（见 app.ts `credentialOf`）。
 */
export const BILIBILI_SESSION_COOKIE_NAMES = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'buvid3',
  'bili_ticket',
] as const

/* ============================ 基础请求 ============================ */

interface BiliResponse<T> {
  code: number
  message?: string
  data?: T
}

/**
 * 解析失败自动重试：只要**任何**一次请求失败（网络错误 / 非 2xx / 上游非 0 业务码）就按固定
 * 333ms 间隔重试，**与具体错误码无关**——以免把「播放出错，请检查网络后重试」这类失败透给用户。
 */
const MAX_RETRIES = 5
const RETRY_DELAY_MS = 333

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 带重试的 GET。
 *
 * 网络错误 / 非 2xx / `code !== 0` **一律重试**（不区分具体错误码），最多 {@link MAX_RETRIES} 次；
 * 仍失败则抛出，由各调用点降级（`parts`/`songUrl` 返空、`searchSongs` 交由路由回 502）。
 */
async function bGet<T>(url: string, cookie?: string): Promise<BiliResponse<T>> {
  let lastErr: Error = new Error('bilibili 请求失败')
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: REFERER,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BiliResponse<T>
      if (json.code !== 0) {
        lastErr = new Error(`bilibili code ${json.code}`)
        continue
      }
      return json
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr
}

/** 进程内缓存 buvid3（匿名反爬标识，实测 6h 内有效），避免每个请求都去取。 */
let buvidCache: { value: string; at: number } | null = null
async function buvid3(): Promise<string | undefined> {
  if (buvidCache && Date.now() - buvidCache.at < 6 * 3600_000)
    return buvidCache.value
  try {
    const res = await bGet<{ b_3?: string }>(
      'https://api.bilibili.com/x/frontend/finger/spi',
    )
    const v = res.data?.b_3
    if (v) {
      buvidCache = { value: v, at: Date.now() }
      return v
    }
  } catch {
    /* 取不到不阻断：多数接口匿名也能用 */
  }
  return buvidCache?.value
}

/** 在访客凭证基础上补一个 buvid3。 */
async function cookieWithBuvid(cred?: string): Promise<string | undefined> {
  const b = await buvid3()
  const parts = [cred, b ? `buvid3=${b}` : undefined].filter(Boolean)
  return parts.length ? parts.join('; ') : undefined
}

/* ============================ 归一化（导出供单测） ============================ */

/** B 站返回的视频条目（部分字段）。 */
export interface RawVideo {
  bvid?: string
  aid?: number
  title?: string
  author?: string
  pic?: string
  /** 形如 `"222:28"` 或 `"12:34"`。 */
  duration?: string
}

/** 去掉搜索结果标题里的 `<em>` 高亮标签并解码常见 HTML 实体。 */
export function decodeTitle(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/** `"222:28"` / `"12:34"` → 秒；非法返回 0。 */
export function parseDuration(d?: string): number {
  if (!d) return 0
  const parts = d.split(':').map((x) => Number(x))
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 封面/头像 URL：补 `https:` 并把 i0–iN 镜像主机规范化到固定主机。 */
export function canonicalBiliImage(url: string | undefined): string {
  if (!url) return ''
  const abs = url.startsWith('//') ? `https:${url}` : url
  try {
    const u = new URL(abs)
    u.protocol = 'https:'
    if (/^i\d+\.hdslb\.com$/.test(u.hostname)) u.hostname = BILI_IMAGE_HOST
    return u.href
  } catch {
    return ''
  }
}

/** 把 B 站视频条目归一化为共享 `Track`（`id` = bvid）。 */
export function normalizeBilibiliTrack(v: RawVideo): Track {
  return {
    source: 'bilibili',
    id: String(v.bvid ?? v.aid ?? ''),
    title: decodeTitle(v.title ?? '') || '未知视频',
    artist: v.author ?? '未知 UP 主',
    album: '',
    cover: canonicalBiliImage(v.pic),
    duration: parseDuration(v.duration),
    fee: 'free',
  }
}

/* ============================ 搜索 ============================ */

interface SearchAllData {
  result?: { result_type?: string; data?: RawVideo[] }[]
}

/**
 * 关键词搜索视频。
 *
 * 走 `search/all/v2`（实测未被风控），取其 `video` 分组。该接口对匿名请求即返回结果。
 * `page` 从 1 起（每页约 20 条），供前端滚动续取下一批。
 */
export async function searchSongs(
  keywords: string,
  limit = 30,
  cred?: string,
  page = 1,
): Promise<Track[]> {
  const cookie = await cookieWithBuvid(cred)
  const res = await bGet<SearchAllData>(
    `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(
      keywords,
    )}&page=${Math.max(1, page)}`,
    cookie,
  )
  const groups = res.data?.result ?? []
  const videos = groups.find((g) => g.result_type === 'video')?.data ?? []
  return videos.slice(0, limit).map(normalizeBilibiliTrack)
}

/* ============================ 取音频（DASH 分轨） ============================ */

/** 各抽象档位对应的目标码率（bps），用于从 `dash.audio[]` 里挑最接近的一条。 */
const LEVEL_TARGET_BPS: Record<AudioLevel, number> = {
  standard: 64_000,
  higher: 132_000,
  exhigh: 192_000,
  lossless: 1_000_000,
  hires: 2_000_000,
}

/** DASH 音频流条目（部分字段）。 */
export interface BiliAudio {
  baseUrl?: string
  backupUrl?: string[]
  bandwidth?: number
  id?: number
}

/** 从多档音频里挑与目标码率最接近的一条（并列取更高码率）。 */
export function pickAudio(
  audios: BiliAudio[],
  level: AudioLevel,
): BiliAudio | undefined {
  const target = LEVEL_TARGET_BPS[level]
  let best: BiliAudio | undefined
  for (const a of audios) {
    if (!best) {
      best = a
      continue
    }
    const bw = a.bandwidth ?? 0
    const bwBest = best.bandwidth ?? 0
    const d = Math.abs(bw - target)
    const dBest = Math.abs(bwBest - target)
    if (d < dBest || (d === dBest && bw > bwBest)) best = a
  }
  return best
}

/**
 * 候选 CDN 排序：**官方 upos 主 CDN（`*.bilivideo.com`）优先**，`mcdn` P2P 边缘节点殿后，并去重。
 *
 * B 站 `playurl` 返回的 `baseUrl` 实测**恒为 `*.mcdn.bilivideo.cn`**（P2P 边缘，用于给真实用户
 * 就近分发），对**数据中心 IP / 非浏览器客户端**极不稳（403 / 连接重置 / 中途 RST）；稳定的官方源
 * 藏在 `backupUrl[]` 里（`upos-sz-*.bilivideo.com`）。故按主机分档重排——取字节阶段再逐个回退，
 * 单节点故障便不会直接判死（否则表现为「概率性播放出错，再点一次就好」）。
 */
export function rankAudioUrls(urls: string[]): string[] {
  const score = (u: string): number => {
    let h: string
    try {
      h = new URL(u).hostname.toLowerCase()
    } catch {
      return 2
    }
    if (/(^|\.)mcdn\.bilivideo\.cn$/.test(h)) return 3 // P2P 边缘：最不稳，殿后
    if (h.endsWith('.bilivideo.com')) return 0 // 官方 upos 主 CDN：首选
    if (h.endsWith('.bilivideo.cn')) return 1 // 官方直连（非 mcdn）
    return 2 // 其它第三方边缘
  }
  return [...new Set(urls)].sort((a, b) => score(a) - score(b))
}

interface PlayurlData {
  dash?: { audio?: BiliAudio[] }
  durl?: { url?: string }[]
}

/**
 * 解析某视频的**音频**直链候选：`pagelist` 取 cid → `playurl(fnval=16)` 取 `dash.audio`，
 * 按档位挑一条，返回其 `baseUrl + backupUrl[]` 的**有序候选**（官方 upos 优先，见
 * {@link rankAudioUrls}），统一改写为 https。**只取音频、不解析视频**。
 *
 * 返回空数组即不可播放（交由路由回 403）。
 */
export async function songUrl(
  id: string,
  cred?: string,
  level: AudioLevel = DEFAULT_AUDIO_LEVEL,
): Promise<string[]> {
  try {
    // id 形如 `<bvid>`（整视频取首P）或 `<bvid>:<cid>`（分P 展开后的具体一页）
    const [bvid, cidRaw] = id.split(':')
    const cookie = await cookieWithBuvid(cred)
    let cid = cidRaw ? Number(cidRaw) : undefined
    if (!cid) {
      const pl = await bGet<{ cid?: number }[]>(
        `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
        cookie,
      )
      cid = pl.data?.[0]?.cid
    }
    if (!cid) return []

    const pu = await bGet<PlayurlData>(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
        bvid,
      )}&cid=${cid}&fnval=16&fnver=0&fourk=1`,
      cookie,
    )
    const audios = pu.data?.dash?.audio ?? []
    const picked = pickAudio(audios, level)
    // DASH：取该档的 baseUrl + 全部 backupUrl；无 dash 时回落老格式 durl
    const candidates = picked
      ? [picked.baseUrl, ...(picked.backupUrl ?? [])]
      : (pu.data?.durl ?? []).map((d) => d.url)
    return rankAudioUrls(
      candidates
        .filter((u): u is string => typeof u === 'string' && u !== '')
        .map((u) => u.replace(/^http:/, 'https:')),
    )
  } catch {
    return []
  }
}

/** 音频 CDN 要求 `Referer`，否则 403。 */
export function streamHeaders(): Record<string, string> {
  return { Referer: REFERER }
}

/* ============================ 分P 展开 ============================ */

/** `x/web-interface/view` 返回的页（分P）结构（部分字段）。 */
interface RawPage {
  cid?: number
  page?: number
  part?: string
  duration?: number
}

/** `x/web-interface/view` 返回的视频结构（部分字段）。 */
export interface BiliViewData {
  bvid?: string
  title?: string
  pic?: string
  owner?: { name?: string }
  pages?: RawPage[]
}

/**
 * 把 `view` 响应归一化为分P 条目（**纯函数**，供单测）。
 *
 * 每项 `id` 为 **`<bvid>:<cid>`**：`songUrl` 据此直接定位到该分P，无需再查 cid。
 * 多P 时标题直接取分P 名（不带 `P<n> ·` 前缀——队列 / 播放条里读的是分P 名本身，
 * 序号信息由列表位置承载；分P 名缺失时回落视频标题），单P 时取视频标题；
 * 封面统一为**视频封面**。
 */
export function buildParts(d: BiliViewData | undefined): Track[] {
  const pages = d?.pages ?? []
  const bvid = d?.bvid
  if (!bvid || !pages.length) return []
  const cover = canonicalBiliImage(d?.pic)
  const artist = d?.owner?.name ?? '未知 UP 主'
  const multi = pages.length > 1
  return pages.map((p) => ({
    source: 'bilibili' as const,
    id: `${bvid}:${p.cid ?? p.page ?? 0}`,
    title: multi
      ? p.part?.trim() || d?.title || '未知视频'
      : (d?.title ?? '未知视频'),
    artist,
    album: '',
    cover,
    duration: p.duration ?? 0,
    fee: 'free' as const,
  }))
}

/**
 * 解析一个视频的**分P**（单P 视频只有一项）。
 *
 * 走 `x/web-interface/view?bvid=`——**一次请求**即含标题 / 封面 / UP 主与 `pages[]`
 * （每页的 `cid` / `page` / `part` / `duration`），故无需再单独请求 `pagelist`。
 */
export async function parts(id: string, cred?: string): Promise<Track[]> {
  try {
    const bvid = id.split(':')[0]
    const cookie = await cookieWithBuvid(cred)
    const res = await bGet<BiliViewData>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      cookie,
    )
    return buildParts(res.data)
  } catch {
    return []
  }
}

/* ============================ 字幕（作为歌词，ADR-035） ============================ */

/** `player/wbi/v2` 返回的字幕轨元信息（部分字段，2026-10 登录态实测）。 */
export interface BiliSubtitleMeta {
  /** 语言代码：人工 CC 如 `zh` / `en` / `zh-CN`；AI 生成带 `ai-` 前缀（如 `ai-zh`）。 */
  lan?: string
  /** 展示名（如「中文」/「English」）。 */
  lan_doc?: string
  /** 播放器默认展示轨。**现代数据实测几乎恒为 false**（UP 不再设锁定），仅作兜底信号。 */
  is_lock?: boolean
  /**
   * 协议相对地址，统一挂 `//aisubtitle.hdslb.com/…`（人工 CC 与 AI 皆然），带 `auth_key`
   * 时效签名——**每次取词现拉列表、现用现取**，不要持久化。另有混淆的 `subtitle_url_v2`
   * （`subtitle.bilibili.com`），对非浏览器客户端 TLS 直接拒连（实测），弃用。
   */
  subtitle_url?: string
  /** **0 = 人工 CC、1 = AI 生成**——比 `ai_type` 更语义化的判据（两者冗余并存）。 */
  type?: number
  /** 1 = AI 生成（与 `type` 冗余）；`ai_status = 2` 表示生成完成。 */
  ai_type?: number
  ai_status?: number
}

/** 字幕正文 JSON（`subtitle_url` 指向文件）里 `body[]` 的单行。 */
export interface BiliSubtitleLine {
  from?: number | string
  to?: number | string
  content?: string
}

/** 中文语言族判定：`zh` / `zh-CN` / `zh-Hans` / `zh-Hant` / `ai-zh`…（剥 `ai-` 前缀后主代码为 `zh` 即算）。 */
export function isChineseLan(lan: string | undefined): boolean {
  if (!lan) return false
  const parts = lan.split('-')
  return (parts[0] === 'ai' ? parts[1] : parts[0]) === 'zh'
}

/** AI 字幕轨判定：`type = 1` / `ai_type = 1` / `ai-` 前缀语言码，任一命中即算。 */
function isAiTrack(s: BiliSubtitleMeta): boolean {
  return (
    (s.type ?? 0) === 1 ||
    (s.ai_type ?? 0) === 1 ||
    (s.lan ?? '').startsWith('ai-')
  )
}

/** 字幕轨挑选结果：主轨为歌词正文，中文轨（若有）为翻译。 */
export interface SubtitleTrackPick {
  main: BiliSubtitleMeta & { subtitle_url: string }
  zh?: BiliSubtitleMeta & { subtitle_url: string }
}

/**
 * 选轨规则（需求：主语言非中文时引入多语言、且必含中文；对齐 B 站「双语字幕」模式——
 * 原文在上、中文译文在下）：
 *
 * - **原文轨优先**：主轨 = 首条**非中文人工轨**（`type ≠ 1`）→ 锁定轨 → 列表首条。
 *   实证（乔布斯演讲 `BV1pchc6nEsh`）：人工中文译轨常排在英文原文轨**之前**，若按列表
 *   顺序取首条会把译文当主语言、丢掉原文；B 站生态里「外语视频 = 原文 CC + 中文译 CC」
 *   是绝对主流（华语视频配外语译轨极罕见——错判时译文仍在、仅主次对调）。AI 轨不作
 *   原文候选：`ai-zh` 对华语视频是语音识别、对外语视频是翻译，方向不定。
 * - 主轨**已是中文** → 单语使用，不叠翻译（华语视频 / 仅 `ai-zh` 的外语视频皆然）；
 * - 主轨非中文 → 再挑一条中文轨作 `translation`，沿用网易云「原文 + 译文」模型
 *   （`LyricLine.translation` 单译文槽，前端零改动）；**人工 CC 优先、AI 字幕兜底**；
 * - 无 `subtitle_url` 的轨（如未登录时 AI 轨不带地址）不参与；全无可用轨返回 null
 *   （含「未登录 subtitles 恒空」的匿名场景）。
 */
export function pickSubtitleTracks(
  subs: BiliSubtitleMeta[],
): SubtitleTrackPick | null {
  const usable = subs.filter(
    (s): s is BiliSubtitleMeta & { subtitle_url: string } =>
      typeof s.subtitle_url === 'string' && s.subtitle_url !== '',
  )
  if (!usable.length) return null
  const manualNonZh = usable.filter(
    (s) => !isAiTrack(s) && !isChineseLan(s.lan),
  )
  const main = manualNonZh[0] ?? usable.find((s) => s.is_lock) ?? usable[0]
  if (isChineseLan(main.lan)) return { main }
  const chinese = usable.filter((s) => isChineseLan(s.lan))
  if (!chinese.length) return { main }
  const zh = chinese.find((s) => !isAiTrack(s)) ?? chinese[0]
  return { main, zh }
}

/** `from` / `to` 容错转秒：上游偶以字符串承载，非法 / 缺失返回 undefined。 */
function asSeconds(v: number | string | undefined): number | undefined {
  const n = typeof v === 'number' ? v : v != null ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * 由字幕轨构建共享 `Lyric`（纯函数，供单测）。
 *
 * 主轨逐行映射为 `LyricLine`（`time = from`）；中文轨按**时间窗重叠**对齐为 `translation`——
 * 两轨常出自不同作者、**分段不一致**（一句原文对 N 句中文、或反过来），不能像 `parseLrc`
 * 那样按时间相等配对（±0.01s 容差拿来必挂），改为**最大重叠挂载**：
 *
 * - 每条中文行挂到与其重叠时长**最大**的原文行（并列取更早）——跨作者分段错位时，
 *   相比「挂首条重叠行」分布更均匀；两轨分段一致（同作者逐句对照，实测人工 CC 常见）
 *   时自然退化为逐行精确配对，无需特判；
 * - 多条中文行挂到同一原文行 → 按时间顺序以空格连接；
 * - 与任何原文行都无有效重叠（落在间隙）的中文行 → 丢弃（时间轴错位时的安全降级）。
 */
export function buildLyricFromSubtitles(
  main: BiliSubtitleLine[],
  zh?: BiliSubtitleLine[],
): Lyric {
  /** 重叠判定的容差（秒），规避浮点边界抖动。 */
  const EPS = 0.05
  /** 容错归一：滤掉缺时间 / 空正文的行，空白折叠为单行，按开始时间排序。 */
  const normalize = (
    arr: BiliSubtitleLine[],
  ): { from: number; to?: number; text: string }[] => {
    const out: { from: number; to?: number; text: string }[] = []
    for (const l of arr) {
      const from = asSeconds(l.from)
      if (from === undefined) continue
      const text =
        typeof l.content === 'string'
          ? l.content.replace(/\s+/g, ' ').trim()
          : ''
      if (!text) continue
      const to = asSeconds(l.to)
      out.push(to !== undefined ? { from, to, text } : { from, text })
    }
    return out.sort((a, b) => a.from - b.from)
  }

  const m = normalize(main)
  if (!m.length) return { lines: [], timed: false }
  const lines: LyricLine[] = m.map((l) => ({ time: l.from, text: l.text }))
  /** 各原文行（含兜底时间窗，见下）的结束时间，预计算供重叠计算复用。 */
  const ends = m.map((l, i) => l.to ?? m[i + 1]?.from ?? l.from + 3)

  if (zh?.length) {
    const z = normalize(zh)
    /** 每条原文行命中的中文文本（保持中文行时间顺序）。 */
    const parts: string[][] = m.map(() => [])
    for (const line of z) {
      const zs = line.from
      const ze = line.to ?? zs + 3
      let best = -1
      let bestOverlap = 0
      for (let i = 0; i < m.length; i++) {
        if (m[i].from >= ze) break // 原文行已整体晚于本中文行，其后更晚 → 剪枝
        const overlap = Math.min(ends[i], ze) - Math.max(m[i].from, zs)
        if (overlap > bestOverlap + 1e-9) {
          bestOverlap = overlap
          best = i
        }
      }
      if (best >= 0 && bestOverlap > EPS) parts[best].push(line.text)
    }
    for (let i = 0; i < lines.length; i++) {
      if (parts[i].length)
        lines[i].translation = [...new Set(parts[i])].join(' ')
    }
  }
  return { lines, timed: true }
}

/* ---------- wbi 签名（字幕轨列表走 `player/wbi/v2`） ---------- */

/** 混淆盐表（B 站前端公开常量，见 bilibili-API-collect「wbi 签名」）。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
] as const

/** `wbi_img` 图 URL（`https://i0.hdslb.com/bfs/wbi/<key>.png`）→ `<key>`。 */
export function extractWbiKey(url: string | undefined): string {
  const last = (url ?? '').split('/').pop() ?? ''
  return last.split('.')[0] ?? ''
}

/** img_key + sub_key（各 32 位）→ 32 位混淆密钥（纯函数，供单测）。 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '')
    .join('')
    .slice(0, 32)
}

/** encodeURIComponent 后再转义 `!'()*`（对齐 B 站前端 / Python `quote` 的行为）。 */
const wbiEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/**
 * 对查询参数做 wbi 签名，返回完整 query 串（含 `wts` 与 `w_rid`）。
 * 规则：滤空值 → 按键排序 → 追加 `wts` → `md5(query + mixinKey)`。`wts` 可注入以便单测。
 */
export function signWbi(
  params: Record<string, string | number>,
  key: string,
  wts = Math.floor(Date.now() / 1000),
): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = [
    ...pairs.map(([k, v]) => `${wbiEncode(k)}=${wbiEncode(v)}`),
    `wts=${wts}`,
  ].join('&')
  const wRid = createHash('md5')
    .update(query + key)
    .digest('hex')
  return `${query}&w_rid=${wRid}`
}

/** 进程内缓存混淆密钥（`nav.wbi_img` 约每日轮换，保守 24h）。 */
let wbiKeyCache: { value: string; at: number } | null = null
const WBI_KEY_TTL_MS = 24 * 3600_000

async function wbiMixinKey(cookie?: string): Promise<string> {
  if (wbiKeyCache && Date.now() - wbiKeyCache.at < WBI_KEY_TTL_MS)
    return wbiKeyCache.value
  const res = await bGet<{ wbi_img?: { img_url?: string; sub_url?: string } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    cookie,
  )
  const key = mixinKey(
    extractWbiKey(res.data?.wbi_img?.img_url),
    extractWbiKey(res.data?.wbi_img?.sub_url),
  )
  if (key.length === 32) wbiKeyCache = { value: key, at: Date.now() }
  return key
}

/** `player` 信息里我们只关心字幕轨列表。 */
interface PlayerInfoData {
  subtitle?: { subtitles?: BiliSubtitleMeta[] }
}

/**
 * 取播放器信息（字幕轨列表）。走 **wbi 签名的 `player/wbi/v2`**（文档正道，yt-dlp 同款）；
 * 签名密钥取不到或请求持续失败时，回落非签名 `player/v2` 一次兜底。
 *
 * ⚠️ **字幕列表要求登录**（SESSDATA）：匿名请求 `subtitles` 恒为空（2026-10 实测，wbi 签名
 * 也救不了），与网页端未登录看不到 CC 一致；浏览器扫码登录或服务端缺省凭证
 * （`BILIBILI_COOKIE`，`pnpm log-in:bilibili`）均可解锁，AI 字幕（`ai-*`）亦仅登录后可见。
 */
async function playerInfo(
  bvid: string,
  cid: number,
  cookie?: string,
): Promise<PlayerInfoData> {
  let data: PlayerInfoData | undefined
  try {
    const key = await wbiMixinKey(cookie)
    if (key) {
      const res = await bGet<PlayerInfoData>(
        `https://api.bilibili.com/x/player/wbi/v2?${signWbi({ bvid, cid }, key)}`,
        cookie,
      )
      data = res.data
    }
  } catch {
    /* 签名版失败 → 回落非签名版 */
  }
  if (!data) {
    const res = await bGet<PlayerInfoData>(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      cookie,
    )
    data = res.data
  }
  return data ?? {}
}

/** 拉取字幕正文（`//` 补 https；AI 字幕地址自带签名 token，仍带 cookie 保险）。失败返回空。 */
async function fetchSubtitleLines(
  url: string,
  cookie?: string,
): Promise<BiliSubtitleLine[]> {
  const abs = url.startsWith('//')
    ? `https:${url}`
    : url.replace(/^http:/, 'https:')
  try {
    const res = await fetch(abs, {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
    if (!res.ok) return []
    const json = (await res.json()) as { body?: BiliSubtitleLine[] }
    return Array.isArray(json.body) ? json.body : []
  } catch {
    return []
  }
}

/**
 * 取视频**字幕**作为「歌词」（ADR-035）。
 *
 * `id` 形如 `<bvid>`（取首P）或 `<bvid>:<cid>`（分P 直接定位）。语言策略见
 * {@link pickSubtitleTracks}、时间对齐见 {@link buildLyricFromSubtitles}。
 * 任何失败一律降级为空歌词（前端显示「暂无歌词」）——歌词是锦上添花，不打挂播放链路。
 */
export async function getLyric(id: string, cred?: string): Promise<Lyric> {
  const empty = (): Lyric => ({ lines: [], timed: false })
  try {
    const [bvid, cidRaw] = id.split(':')
    const cookie = await cookieWithBuvid(cred)
    let cid = cidRaw ? Number(cidRaw) : undefined
    if (!cid) {
      const pl = await bGet<{ cid?: number }[]>(
        `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
        cookie,
      )
      cid = pl.data?.[0]?.cid
    }
    if (!cid) return empty()

    const info = await playerInfo(bvid, cid, cookie)
    const pick = pickSubtitleTracks(info.subtitle?.subtitles ?? [])
    if (!pick) return empty()

    const [main, zh] = await Promise.all([
      fetchSubtitleLines(pick.main.subtitle_url, cookie),
      pick.zh
        ? fetchSubtitleLines(pick.zh.subtitle_url, cookie)
        : Promise.resolve([]),
    ])
    if (!main.length) return empty()
    return buildLyricFromSubtitles(main, zh.length ? zh : undefined)
  } catch {
    return empty()
  }
}

/* ============================ 登录（扫码） ============================ */

/**
 * 生成登录二维码。**返回二维码内容本身（登录 URL）作为 key**。
 *
 * 与网易云不同，B 站的 `key` 与 `url` 来自同一份 generate 响应、且后续 `poll` 只认
 * `qrcode_key`。故让「URL 即 key」：`qrCreate` 直接渲染它、`qrCheck` 从 URL 里解析出
 * `qrcode_key` 去轮询——全程无状态，无需服务端缓存。
 */
export async function qrKey(): Promise<string> {
  const res = await bGet<{ url?: string; qrcode_key?: string }>(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
  )
  return res.data?.url ?? ''
}

/**
 * 把二维码内容渲染为 base64 PNG data URI。
 *
 * `margin` 为**静区**（四周留白，单位＝模块数）：QR 规范要求 ≥4，且前端展示框是纯白底 +
 * `object-fit: contain`，留白完全来自图片本身——取 1 会让码几乎填满整框、又大又挤，故用 4。
 */
export async function qrCreate(key: string): Promise<string> {
  return QRCode.toDataURL(key, { margin: 4, width: 240 })
}

/** 二维码内容（登录 URL）——供 CLI 终端渲染。 */
export async function qrLoginUrl(key: string): Promise<string> {
  return key
}

/** 从 Set-Cookie 数组里挑出会话 cookie，收敛为可直接透传的字符串。 */
export function cookieHeaderFromSetCookies(
  cookies?: string[],
): string | undefined {
  if (!cookies?.length) return undefined
  const parts: string[] = []
  for (const c of cookies) {
    const kv = c.split(';')[0]?.trim()
    if (!kv) continue
    const name = kv.slice(0, kv.indexOf('='))
    if ((BILIBILI_SESSION_COOKIE_NAMES as readonly string[]).includes(name))
      parts.push(kv)
  }
  return parts.length ? parts.join('; ') : undefined
}

/** 从 URL 查询串里取**原始（未解码）**参数值——`SESSDATA` 含 `%2C`，解码会破坏其值。 */
export function rawQueryValue(url: string, name: string): string | undefined {
  const q = url.indexOf('?')
  if (q < 0) return undefined
  const hash = url.indexOf('#', q)
  const query = url.slice(q + 1, hash < 0 ? undefined : hash)
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1)
  }
  return undefined
}

/**
 * 汇总登录后的会话 cookie：优先取 poll 的 `Set-Cookie`，缺失的再从回跳 URL 的查询串补齐。
 *
 * ⚠️ URL 里的值必须**保持原始百分号编码、不可解码**：B 站 `SESSDATA` 本身含 `%2C`
 * （其 cookie 值就是带 `%2C` 的形态），解码成 `,` 会写出**非法且错误**的 cookie 值——
 * 浏览器按 RFC 6265 拒存（逗号非合法 cookie-value 字符），或即便存下 nav 也不认，
 * 表现为「登录成功但一刷新登录就掉」。
 */
export function collectLoginCookies(
  setCookies: string[],
  url?: string,
): string[] {
  const out = [...setCookies]
  const have = new Set(
    out.map((c) => c.slice(0, c.indexOf('='))).filter(Boolean),
  )
  if (url) {
    for (const name of BILIBILI_SESSION_COOKIE_NAMES) {
      if (have.has(name)) continue
      const raw = rawQueryValue(url, name)
      if (raw != null) out.push(`${name}=${raw}`)
    }
  }
  return out
}

/**
 * 轮询扫码状态。归一为与网易云一致的 code 语义：
 * `0`→803 成功、`86090`→802 已扫码待确认、`86038`→800 已失效、其它（`86101` 未扫码）→801。
 */
export async function qrCheck(key: string): Promise<QrCheckResult> {
  let qrcodeKey = key
  try {
    qrcodeKey = new URL(key).searchParams.get('qrcode_key') ?? key
  } catch {
    /* key 本身可能就是 qrcode_key */
  }
  const res = await fetch(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
      qrcodeKey,
    )}`,
    { headers: { 'User-Agent': UA, Referer: REFERER } },
  )
  const json = (await res.json()) as BiliResponse<{
    code?: number
    message?: string
    url?: string
  }>
  const inner = json.data?.code ?? -1
  const message = json.data?.message

  if (inner === 0) {
    const cookies = collectLoginCookies(
      res.headers.getSetCookie?.() ?? [],
      json.data?.url,
    )
    return { code: 803, cookies, message: message ?? '登录成功' }
  }
  const code = inner === 86090 ? 802 : inner === 86038 ? 800 : 801
  return { code, message }
}

/** 查询登录态。 */
export async function loginStatus(cred?: string): Promise<LoginStatus> {
  if (!cred) return { logged: false }
  try {
    const res = await bGet<{
      isLogin?: boolean
      uname?: string
      face?: string
      mid?: number
      vipStatus?: number
    }>('https://api.bilibili.com/x/web-interface/nav', cred)
    const d = res.data
    if (!d?.isLogin) return { logged: false }
    return {
      logged: true,
      nickname: d.uname,
      avatarUrl: d.face ? canonicalBiliImage(d.face) : undefined,
      userId: d.mid != null ? String(d.mid) : undefined,
      vip: Boolean(d.vipStatus),
    }
  } catch {
    return { logged: false }
  }
}

/* ============================ 适配器 ============================ */

/** MV 无专辑页，返回空壳以满足适配器必选面（前端不会走到）。 */
export async function albumDetail(
  id: string,
): Promise<{ album: Album; tracks: Track[] }> {
  return {
    album: { source: 'bilibili', id, name: '', cover: '', artist: '' },
    tracks: [],
  }
}

/** B 站（MV）音源适配器。字幕作歌词（`getLyric`）、分P（`parts`）与扫码登录的实现见上文各节。 */
export const bilibiliAdapter: SourceAdapter = {
  id: 'bilibili',
  sessionCookieNames: BILIBILI_SESSION_COOKIE_NAMES,
  logoutCookieNames: BILIBILI_SESSION_COOKIE_NAMES,
  searchSongs,
  albumDetail,
  songUrl,
  getLyric,
  loginStatus,
  cookieHeaderFromSetCookies,
  streamHeaders,
  parts,
  qrKey,
  qrCreate,
  qrLoginUrl,
  qrCheck,
}
