import { createRequire } from 'node:module'
import QRCode from 'qrcode'
import {
  DEFAULT_AUDIO_LEVEL,
  type Album,
  type Artist,
  type AudioLevel,
  type AudioQuality,
  type LoginStatus,
  type Playlist,
  type PlaylistCategoryGroup,
  type Track,
  type Lyric,
} from '@pterosaur/shared/types'
import { parseLrc } from '@pterosaur/shared/lyric'
import { canonicalNeteaseImage, COVER_LARGE } from '@pterosaur/shared/image'
import type { SourceAdapter } from './types.js'

const require = createRequire(import.meta.url)

/**
 * NeteaseCloudMusicApi 以 CommonJS 导出，键名去掉前导斜杠（如 `cloudsearch`）。
 * 每个函数签名约为 `(query, cookie?) => Promise<{ status, body, cookie? }>`，
 * 但不同版本存在差异，这里用宽松的 `any` 承接并在使用处收敛。
 *
 * 返回的 `cookie` 字段是「原始 Set-Cookie 字符串数组」（如
 * `["MUSIC_U=...; Max-Age=...; Path=/;", "__csrf=...; ..."]`）。
 * 登录成功后我们把这些原样作为 `Set-Cookie` 头下发给浏览器，
 * 浏览器在后续请求自动回传，再透传给网易云即可维持会话。
 */
interface NcmResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  cookie?: string[]
  status?: number
}
type NcmFn = (query: Record<string, unknown>) => Promise<NcmResponse>
const api = require('NeteaseCloudMusicApi') as Record<string, NcmFn>

/**
 * 从 Set-Cookie 数组中提取指定 cookie 的值。
 * 用于在不透传原始头的场景（如判断登录态）读取 MUSIC_U。
 */
export function readCookieValue(
  cookies: string[] | undefined,
  name: string,
): string | undefined {
  if (!cookies) return undefined
  for (const c of cookies) {
    const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    if (m) return m[1]
  }
  return undefined
}

/** 会话必需的网易云 cookie 名单：下发与回传均只处理这几项，避免多余 Set-Cookie 撑大响应头。 */
export const SESSION_COOKIE_NAMES = ['MUSIC_U', '__csrf', 'MUSIC_A', 'NMTID']

/** 把登录相关 cookie（MUSIC_U / __csrf 等）收敛为可直接透传给网易云的字符串。 */
export function cookieHeaderFromSetCookies(
  cookies: string[] | undefined,
): string | undefined {
  if (!cookies?.length) return undefined
  const parts: string[] = []
  for (const c of cookies) {
    const kv = c.split(';')[0]?.trim()
    if (!kv) continue
    const name = kv.slice(0, kv.indexOf('='))
    if (SESSION_COOKIE_NAMES.includes(name)) parts.push(kv)
  }
  return parts.length ? parts.join('; ') : undefined
}

/** 网易云返回的原始曲目结构（部分字段）。 */
interface RawSong {
  id: number
  name: string
  fee?: number
  dt?: number
  duration?: number
  ar?: { id?: number; name: string }[]
  artists?: { id?: number; name: string }[]
  al?: { id?: number; name?: string; picUrl?: string; blurPicUrl?: string }
  album?: { id?: number; name?: string; picUrl?: string; blurPicUrl?: string }
}

/** 网易云返回的原始艺人结构（部分字段）。 */
interface RawArtist {
  id: number
  name: string
  picUrl?: string
  alias?: string[]
  albumSize?: number
  musicSize?: number
  briefDesc?: string
}

/** 网易云返回的原始专辑结构（部分字段）。 */
interface RawAlbum {
  id: number
  name: string
  picUrl?: string
  size?: number
  trackCount?: number
  publishTime?: number
  /** 流派标签；上游多为空串 */
  tags?: string
  artist?: { id?: number; name: string }
  artists?: { id?: number; name: string }[]
}

/** 网易云返回的原始歌单结构（部分字段）。 */
interface RawPlaylist {
  id: number
  name: string
  picUrl?: string
  coverImgUrl?: string
  description?: string
  trackCount?: number
  playCount?: number
  creator?: { nickname?: string }
}

/** 把封面/图片地址统一改写为 https。 */
function https(url?: string): string {
  if (!url) return ''
  return url.replace(/^http:\/\//, 'https://')
}

/** 封面/头像基准尺寸（产出大图，前端按使用场景经 `coverAt` 降到小图；见 shared/image）。 */
const BASE_COVER_SIZE = `${COVER_LARGE}y${COVER_LARGE}`

/**
 * 封面 / 头像地址：规范化（https + 固定 CDN 镜像主机，见 shared/image 与 ADR-020）
 * 并设置缩放尺寸（覆盖地址上已有的 `param`）。
 *
 * 网易云会在 p1–pN.music.126.net 间随机轮换主机名（实测同一封面同端点两次调用即不同），
 * 不规范化的话，前端所有以 URL 为键的缓存（SW 媒体池 / 就绪登记表）都会被拆成多条。
 */
function coverUrl(
  raw: string | undefined,
  size: string = BASE_COVER_SIZE,
): string {
  if (!raw) return ''
  const canonical = canonicalNeteaseImage(raw)
  try {
    const u = new URL(canonical)
    u.searchParams.delete('param')
    u.searchParams.set('param', size)
    return u.href
  } catch {
    return ''
  }
}

/** 由 fee 推断版权标记。网易云：0 免费、1/4/8 等通常为 VIP 或付费。 */
function feeOf(fee?: number): Track['fee'] {
  if (fee === undefined || fee === null) return 'unknown'
  if (fee === 0) return 'free'
  if (fee === 8 || fee === 4 || fee === 1) return 'vip'
  return 'unknown'
}

/** 将网易云原始曲目归一化为共享 Track。 */
export function normalizeTrack(raw: RawSong): Track {
  const rawArtists = raw.ar ?? raw.artists ?? []
  const artists = rawArtists.map((a) => a?.name).filter(Boolean)
  const artistRefs = rawArtists
    .filter(
      (a): a is { id: number; name: string } => a?.id != null && !!a?.name,
    )
    .map((a) => ({ id: String(a.id), name: a.name }))
  const album = raw.al ?? raw.album
  const coverRaw = album?.picUrl ?? album?.blurPicUrl ?? ''
  return {
    source: 'netease',
    id: String(raw.id),
    title: raw.name ?? '未知曲目',
    artist: artists.join(' / ') || '未知艺人',
    album: album?.name ?? '',
    // 封面按需放大，网易云支持 ?param=WxH 缩略参数
    cover: coverUrl(coverRaw, BASE_COVER_SIZE),
    duration: Math.round(((raw.dt ?? raw.duration ?? 0) as number) / 1000),
    fee: feeOf(raw.fee),
    // 供界面跳转艺人页 / 专辑页；缺失时前端降级为纯文本
    artistRefs: artistRefs.length ? artistRefs : undefined,
    albumId: album && album.id != null ? String(album.id) : undefined,
  }
}

/** 将网易云原始艺人归一化为共享 Artist。 */
export function normalizeArtist(raw: RawArtist): Artist {
  return {
    source: 'netease',
    id: String(raw.id),
    name: raw.name ?? '未知艺人',
    avatar: coverUrl(raw.picUrl, BASE_COVER_SIZE),
    alias: raw.alias?.length ? raw.alias : undefined,
    albumSize: raw.albumSize,
    musicSize: raw.musicSize,
    briefDesc: raw.briefDesc || undefined,
  }
}

/** 将网易云原始专辑归一化为共享 Album。 */
export function normalizeAlbum(raw: RawAlbum): Album {
  const list = raw.artists ?? (raw.artist ? [raw.artist] : [])
  const names = list.map((a) => a?.name).filter(Boolean)
  // 逐个艺人的引用（合作专辑每个都能点）；仅保留同时具备 id 与名字的条目，与 normalizeTrack 一致
  const artistRefs = list
    .filter(
      (a): a is { id?: number; name: string } => !!a?.name && a?.id != null,
    )
    .map((a) => ({ id: String(a.id), name: a.name }))
  const primaryId = artistRefs[0]?.id
  return {
    source: 'netease',
    id: String(raw.id),
    name: raw.name ?? '未命名专辑',
    cover: coverUrl(raw.picUrl, BASE_COVER_SIZE),
    artist: names.join(' / ') || '未知艺人',
    artistId: primaryId,
    artistRefs: artistRefs.length ? artistRefs : undefined,
    year: raw.publishTime ? new Date(raw.publishTime).getFullYear() : undefined,
    // 流派：上游 `tags` 字段。目前实测恒为空串（网易云不公开专辑流派），
    // 故仅在非空时填充，界面据「有流派才拼」降级处理。
    genre: raw.tags?.trim() ? raw.tags.trim() : undefined,
    trackCount: raw.size ?? raw.trackCount,
  }
}

/** 将网易云原始歌单归一化为共享 Playlist。 */
export function normalizePlaylist(raw: RawPlaylist): Playlist {
  return {
    source: 'netease',
    id: String(raw.id),
    name: raw.name ?? '未命名歌单',
    cover: coverUrl(raw.coverImgUrl ?? raw.picUrl ?? '', BASE_COVER_SIZE),
    description: raw.description ?? undefined,
    trackCount: raw.trackCount,
    playCount: raw.playCount,
    creator: raw.creator?.nickname,
  }
}

/** 1 起的页码 → 0 起的 offset（网易云 `cloudsearch` 以 `offset` 分页）。 */
function offsetOf(page: number = 1, limit = 30): number {
  return Math.max(0, (Math.max(1, page) - 1) * limit)
}

/**
 * 搜索单曲。
 *
 * @param keywords 关键词
 * @param limit 返回数量上限（默认 30）
 * @param cookie 透传的登录 cookie（可选）
 * @param page 页码（从 1 起；供滚动续取下一批）
 */
export async function searchSongs(
  keywords: string,
  limit = 30,
  cookie?: string,
  page = 1,
): Promise<Track[]> {
  const res = await api.cloudsearch({
    keywords,
    limit,
    offset: offsetOf(page, limit),
    cookie,
  })
  const songs: RawSong[] = res?.body?.result?.songs ?? []
  return songs.map(normalizeTrack)
}

/** 搜索艺人（cloudsearch type=100）。 */
export async function searchArtists(
  keywords: string,
  limit = 30,
  cookie?: string,
  page = 1,
): Promise<Artist[]> {
  const res = await api.cloudsearch({
    keywords,
    type: 100,
    limit,
    offset: offsetOf(page, limit),
    cookie,
  })
  const list: RawArtist[] = res?.body?.result?.artists ?? []
  return list.map(normalizeArtist)
}

/** 搜索专辑（cloudsearch type=10）。 */
export async function searchAlbums(
  keywords: string,
  limit = 30,
  cookie?: string,
  page = 1,
): Promise<Album[]> {
  const res = await api.cloudsearch({
    keywords,
    type: 10,
    limit,
    offset: offsetOf(page, limit),
    cookie,
  })
  const list: RawAlbum[] = res?.body?.result?.albums ?? []
  return list.map(normalizeAlbum)
}

/** 搜索歌单（cloudsearch type=1000）。 */
export async function searchPlaylists(
  keywords: string,
  limit = 30,
  cookie?: string,
  page = 1,
): Promise<Playlist[]> {
  const res = await api.cloudsearch({
    keywords,
    type: 1000,
    limit,
    offset: offsetOf(page, limit),
    cookie,
  })
  const list: RawPlaylist[] = res?.body?.result?.playlists ?? []
  return list.map(normalizePlaylist)
}

/** 首页个性化推荐歌单。 */
export async function recommendPlaylists(
  limit = 12,
  cookie?: string,
): Promise<Playlist[]> {
  const res = await api.personalized({ limit, cookie })
  const list: RawPlaylist[] = res?.body?.result ?? []
  return list.map(normalizePlaylist)
}

/** 排行榜列表。 */
export async function toplists(): Promise<Playlist[]> {
  const res = await api.toplist({})
  const list: RawPlaylist[] = res?.body?.list ?? []
  return list.map((raw) => ({
    ...normalizePlaylist(raw),
    trackCount: raw.trackCount ?? (raw as unknown as { size?: number }).size,
  }))
}

/** 精品歌单。 */
export async function topPlaylists(
  limit = 12,
  cat = '全部',
): Promise<Playlist[]> {
  const res = await api.top_playlist({ limit, cat })
  const list: RawPlaylist[] = res?.body?.playlists ?? []
  return list.map(normalizePlaylist)
}

/**
 * 「新歌精选」：上游推荐的新歌。
 *
 * 上游把每条包在 `{ id, name, picUrl, song }` 里，真正的曲目数据在 `song`；
 * 少数条目 `song` 缺失，直接跳过（没有 `id` 就无法播放）。
 */
export async function newSongs(limit = 20, cookie?: string): Promise<Track[]> {
  const res = await api.personalized_newsong({ limit, cookie })
  const list: { song?: RawSong }[] = res?.body?.result ?? []
  return list
    .map((it) => it.song)
    .filter((s): s is RawSong => !!s && s.id != null)
    .map(normalizeTrack)
}

/**
 * 歌单分类标签（搜索页的流派快捷入口）。
 *
 * 上游 `playlist_catlist` 回 `categories`（id → 分组名）+ `sub`（全部标签，每条带
 * `category` 指向其分组 id）。这里按 `categories` 的声明顺序分组，只保留真正能在
 * 本应用里取到歌单的标签（`topPlaylists(cat)` 接受的就是标签名）。
 */
export async function playlistCategories(): Promise<PlaylistCategoryGroup[]> {
  const res = await api.playlist_catlist({})
  const body = res?.body as
    | {
        categories?: Record<string, string>
        sub?: { name?: string; category?: number }[]
      }
    | undefined
  const categories = body?.categories ?? {}
  const subs = body?.sub ?? []
  return Object.entries(categories).map(([id, name]) => ({
    name,
    tags: subs
      .filter((t) => String(t.category) === id && !!t.name)
      .map((t) => t.name as string),
  }))
}
/** 「本周新发行」：最近发布的专辑（`album_newest`，上游固定回 12 条）。 */
export async function newAlbums(limit = 12): Promise<Album[]> {
  const res = await api.album_newest({})
  const list: RawAlbum[] = res?.body?.albums ?? []
  return list.slice(0, limit).map(normalizeAlbum)
}

/** 歌单详情曲目。 */
export async function playlistTracks(
  id: string,
  cookie?: string,
): Promise<{ playlist: Playlist; tracks: Track[] }> {
  const res = await api.playlist_detail({ id, cookie })
  const pl = res?.body?.playlist
  const playlist: Playlist = pl
    ? {
        source: 'netease',
        id: String(pl.id),
        name: pl.name ?? '未命名歌单',
        cover: coverUrl(pl.coverImgUrl, BASE_COVER_SIZE),
        description: pl.description ?? undefined,
        trackCount: pl.trackCount,
        playCount: pl.playCount,
        creator: pl.creator?.nickname,
      }
    : { source: 'netease', id, name: '歌单', cover: '' }
  const tracks: Track[] = ((pl?.tracks ?? []) as RawSong[]).map(normalizeTrack)
  return { playlist, tracks }
}

/** 艺人详情：档案 + 热门单曲 + 专辑列表。 */
export async function artistDetail(
  id: string,
  cookie?: string,
): Promise<{ artist: Artist; tracks: Track[]; albums: Album[] }> {
  const [info, albumRes] = await Promise.all([
    api.artists({ id, cookie }),
    api.artist_album({ id, limit: 50, cookie }),
  ])
  const artist = normalizeArtist(
    (info?.body?.artist ?? { id, name: '未知艺人' }) as RawArtist,
  )
  const tracks: Track[] = ((info?.body?.hotSongs ?? []) as RawSong[]).map(
    normalizeTrack,
  )
  const rawAlbums: RawAlbum[] =
    albumRes?.body?.hotAlbums ?? albumRes?.body?.albums ?? []
  return { artist, tracks, albums: rawAlbums.map(normalizeAlbum) }
}

/** 专辑详情：档案 + 曲目。 */
export async function albumDetail(
  id: string,
  cookie?: string,
): Promise<{ album: Album; tracks: Track[] }> {
  const res = await api.album({ id, cookie })
  const raw = (res?.body?.album ?? { id, name: '未知专辑' }) as RawAlbum & {
    size?: number
  }
  const album = normalizeAlbum({
    ...raw,
    size: raw.size ?? res?.body?.songs?.length,
  })
  const tracks: Track[] = ((res?.body?.songs ?? []) as RawSong[]).map(
    normalizeTrack,
  )
  return { album, tracks }
}

/**
 * 解析曲目真实播放地址。
 *
 * @param id 曲目 ID
 * @param cookie 登录 cookie（VIP 曲目必需）
 * @param level 音质（exhigh / lossless / hires 等），默认 exhigh
 * @returns 已改写为 https 的可播放地址；无法播放时返回 null
 */
export async function songUrl(
  id: string,
  cookie?: string,
  level: AudioLevel = DEFAULT_AUDIO_LEVEL,
): Promise<string[]> {
  try {
    const res = await api.song_url_v1({ id, level, cookie })
    const url: string | null = res?.body?.data?.[0]?.url ?? null
    return url ? [https(url)] : []
  } catch {
    return []
  }
}

/**
 * 解析给定档位**实际**得到的音频流参数（供沉浸页顶部如实展示，见 ADR-041）。
 *
 * `song_url_v1` 会回报**真正落到**的结果：请求高档而该曲不可得时，网易云降级并如实回报
 * `br` / `sr` / `type`（如请求 `hires` 却只有 320kbps 的曲目会回 `br=320000`、`type=mp3`）。
 * 故直接采信上游字段，不臆造档位名。
 */
export async function audioQuality(
  id: string,
  cookie?: string,
  level: AudioLevel = DEFAULT_AUDIO_LEVEL,
): Promise<AudioQuality | null> {
  try {
    const res = await api.song_url_v1({ id, level, cookie })
    const d = res?.body?.data?.[0]
    if (!d?.url) return null
    const br = typeof d.br === 'number' && d.br > 0 ? d.br : undefined
    const sr = typeof d.sr === 'number' && d.sr > 0 ? d.sr : undefined
    return { codec: codecName(d.type ?? d.encodeType, d.url), br, sr }
  } catch {
    return null
  }
}

/** 由网易云回报的 `type` / `encodeType`（缺失时回退直链后缀）归一为编解码显示名。 */
function codecName(raw: unknown, url: string): string | undefined {
  // 上游字段可能是任意 JSON 值：只接受标量，其余视为缺失
  const s = (
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (s) return s.toUpperCase()
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
  return ext && /^[a-z0-9]{2,4}$/.test(ext) ? ext.toUpperCase() : undefined
}

/** 曲目详情（用于补全搜索未覆盖的元数据）。 */
export async function songDetail(
  ids: string[],
  cookie?: string,
): Promise<Track[]> {
  const res = await api.song_detail({ ids: ids.join(','), cookie })
  const songs: RawSong[] = res?.body?.songs ?? []
  return songs.map(normalizeTrack)
}

/** 获取歌词（含翻译）。 */
export async function getLyric(id: string, cookie?: string): Promise<Lyric> {
  try {
    const res = await api.lyric_new({ id, cookie })
    const lrc: string = res?.body?.lrc?.lyric ?? ''
    const tlyric: string | undefined = res?.body?.tlyric?.lyric
    return parseLrc(lrc, tlyric)
  } catch {
    return { lines: [], timed: false }
  }
}

/* ---------------------- 扫码登录（现行网页协议） ---------------------- */

/**
 * 扫码登录走**网页端现行协议**，不再复用 NeteaseCloudMusicApi 的 `login_qr_*`。
 *
 * 库里的实现写死了三件事：`eapi` 加密、`type=3`、二维码内容 `music.163.com/login?codekey=`。
 * 2026-10 起官方网页改用明文 `/api/login/qrcode/*` + `type=1`，二维码内容改成
 * `https://music.163.com/st/platform/scanlogin?...`——旧链接已 302 到 `/404`，手机 App 认不出，
 * 于是轮询永远停在 801（见 `docs/researches/netease-web-login-protocol.md`）。
 * 这几条端点用明文 form 即可，无需 eapi / weapi 加密，故在此直连上游。
 */
const NETEASE_API_ORIGIN = 'https://music.163.com'
const NETEASE_QR_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 一次明文 POST；返回解析后的 JSON 与原始 Set-Cookie 数组。 */
async function postNeteaseApi(
  path: string,
  body: Record<string, string>,
  extraHeaders: Record<string, string> = {},
  cred?: string,
): Promise<{ data: Record<string, unknown>; cookies: string[] }> {
  const headers: Record<string, string> = {
    'User-Agent': NETEASE_QR_UA,
    Referer: `${NETEASE_API_ORIGIN}/`,
    'Content-Type': 'application/x-www-form-urlencoded',
    ...extraHeaders,
  }
  if (cred) headers.Cookie = cred
  const res = await fetch(NETEASE_API_ORIGIN + path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    data = {}
  }
  return { data, cookies: res.headers.getSetCookie() }
}

/**
 * 每个二维码 key 对应的 `chainId`（`v1_<sDeviceId>_web_login_<ts>`）。
 * 官方把同一条 chainId 既写进二维码链接、又作为轮询请求头 `x-login-chain-id` 回传，
 * 这里按 key 缓存以保持两侧一致；条目有界、2 分钟后清理，避免长驻进程积累。
 */
const qrChainIds = new Map<string, { chainId: string; at: number }>()
const QR_CHAIN_TTL_MS = 2 * 60 * 1000

/** 取（或补建）某 key 的 chainId。 */
function chainIdOf(key: string): string {
  const now = Date.now()
  for (const [k, v] of qrChainIds) {
    if (now - v.at > QR_CHAIN_TTL_MS) qrChainIds.delete(k)
  }
  const hit = qrChainIds.get(key)
  if (hit) return hit.chainId
  const chainId = `v1_unknown-${Math.floor(Math.random() * 1e6)}_web_login_${now}`
  qrChainIds.set(key, { chainId, at: now })
  return chainId
}

/** 生成二维码 key（`unikey`）。 */
export async function qrKey(cookie?: string): Promise<string> {
  const { data } = await postNeteaseApi(
    '/api/login/qrcode/unikey',
    { type: '1' },
    {},
    cookie,
  )
  const key = typeof data.unikey === 'string' ? data.unikey : ''
  if (key) chainIdOf(key)
  return key
}

/**
 * 生成二维码**内容 URL**——现行扫码落地页：
 * `https://music.163.com/st/platform/scanlogin?codekey=…&chainId=…&hdw_device=web&hdw_appid=web&hitExp=1`
 */
export async function qrLoginUrl(
  key: string,
  _cookie?: string,
): Promise<string> {
  const params = new URLSearchParams({
    codekey: key,
    chainId: chainIdOf(key),
    hdw_device: 'web',
    hdw_appid: 'web',
    hitExp: '1',
  })
  return `${NETEASE_API_ORIGIN}/st/platform/scanlogin?${params.toString()}`
}

/** 生成二维码图片（base64 data URI）。二维码内容即 {@link qrLoginUrl}。 */
export async function qrCreate(key: string, cookie?: string): Promise<string> {
  const url = await qrLoginUrl(key, cookie)
  return QRCode.toDataURL(url)
}

/**
 * 检查扫码登录状态。
 * @returns code: 800 过期 / 801 等待扫码 / 802 待确认 / 803 成功（附带原始 Set-Cookie 数组）
 */
export async function qrCheck(
  key: string,
  cookie?: string,
): Promise<{ code: number; cookies?: string[]; message?: string }> {
  const { data, cookies } = await postNeteaseApi(
    '/api/login/qrcode/client/login',
    {
      key,
      type: '1',
      noCheckToken: 'true',
      // 官方用浏览器指纹 SDK 取；取不到时同样以空串继续，Node 侧没有该 SDK 故恒为空
      ydDeviceToken: '',
    },
    { 'X-loginMethod': 'QrCode', 'x-login-chain-id': chainIdOf(key) },
    cookie,
  )
  const code = typeof data.code === 'number' ? data.code : 800
  if (code === 803 || code === 800) qrChainIds.delete(key)
  return {
    code,
    cookies,
    message: typeof data.message === 'string' ? data.message : undefined,
  }
}

/** 查询登录状态。 */
export async function loginStatus(cookie?: string): Promise<LoginStatus> {
  if (!cookie) return { logged: false }
  try {
    const res = await api.login_status({ cookie })
    const profile = res?.body?.data?.profile
    if (!profile) return { logged: false }
    return {
      logged: true,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl
        ? coverUrl(profile.avatarUrl, BASE_COVER_SIZE)
        : undefined,
      userId: profile.userId != null ? String(profile.userId) : undefined,
      vip: Boolean(profile.vipType),
    }
  } catch {
    return { logged: false }
  }
}

/** 获取用户歌单。 */
export async function userPlaylists(
  uid: string,
  cookie?: string,
): Promise<Playlist[]> {
  const res = await api.user_playlist({ uid, cookie })
  const list: RawPlaylist[] = res?.body?.playlist ?? []
  return list.map(normalizePlaylist)
}

/* ============================ 适配器 ============================ */

/**
 * 退出登录需清理的网易云会话 cookie。
 *
 * **必须与 {@link SESSION_COOKIE_NAMES} 全量一致**：登出若漏清任一项（曾漏掉 MUSIC_A / NMTID），
 * 残留项仍会让后端 `cookieOf` 返回非空，于是 `credentialOf` 认定「访客有自己的会话」而**不回落
 * 到服务端缺省凭证**，把 VIP 曲目打回 30 秒试听（见 app.ts `credentialOf`）。直接复用会话名单，
 * 杜绝两处名单各自漂移。
 */
export const NETEASE_LOGOUT_COOKIE_NAMES = SESSION_COOKIE_NAMES

/** 网易云音源适配器（供 `sources` 注册表使用）。 */
export const neteaseAdapter: SourceAdapter = {
  id: 'netease',
  sessionCookieNames: SESSION_COOKIE_NAMES,
  logoutCookieNames: NETEASE_LOGOUT_COOKIE_NAMES,
  searchSongs,
  searchArtists,
  searchAlbums,
  searchPlaylists,
  recommendPlaylists,
  toplists,
  topPlaylists,
  newSongs,
  newAlbums,
  playlistCategories,
  artistDetail,
  albumDetail,
  playlistTracks,
  songUrl,
  audioQuality,
  songDetail,
  getLyric,
  qrKey,
  qrCreate,
  qrLoginUrl,
  qrCheck,
  loginStatus,
  userPlaylists,
  cookieHeaderFromSetCookies,
}
