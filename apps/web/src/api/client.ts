import type {
  Album,
  PlaylistCategoryGroup,
  ApiResult,
  Artist,
  AudioLevel,
  AudioQuality,
  LibraryData,
  LoginStatus,
  Lyric,
  MusicSource,
  Playlist,
  SearchResults,
  SyncEnvelope,
  Track,
} from '@pterosaur/shared/types'
import { API_BASE } from '@pterosaur/shared/types'
import type {
  RipBurnRequestBody,
  RipCapabilities,
  RipJobSnapshot,
  RipLastResult,
} from '@pterosaur/shared/rip'

/** 统一的 GET JSON 请求，解析后端 `ApiResult` 包裹。 */
async function get<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url.toString(), { credentials: 'include' })
  const json = (await res.json().catch(() => null)) as ApiResult<T> | null
  if (!json || !json.ok) {
    const err = new Error(
      json?.error ?? `请求失败（${res.status}）`,
    ) as Error & {
      needLogin?: boolean
      status?: number
    }
    err.needLogin = json?.needLogin
    err.status = res.status
    throw err
  }
  return json.data as T
}

/** 带 JSON body 的写请求（POST / PUT），解析后端 `ApiResult` 包裹。 */
async function send<T>(
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as ApiResult<T> | null
  if (!json || !json.ok) {
    const err = new Error(
      json?.error ?? `请求失败（${res.status}）`,
    ) as Error & { needLogin?: boolean }
    err.needLogin = json?.needLogin
    throw err
  }
  return json.data as T
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  send<T>('POST', path, body)
const put = <T>(path: string, body?: unknown): Promise<T> =>
  send<T>('PUT', path, body)

export const api = {
  search: (source: MusicSource, keywords: string, limit = 30) =>
    get<Track[]>(`${API_BASE}/search`, { keywords, limit, source }),

  /**
   * 多类型搜索：并行返回歌曲 / 艺术家 / 专辑 / 歌单；`page` 供滚动续取，`type` 限定只跑一类。
   * 磁带渠道（B 站）的 `playlists` 即**磁带**（`source:'bilibili'` 的 Playlist，见 ADR-044）。
   */
  searchAll: (
    source: MusicSource,
    keywords: string,
    limit = 20,
    page?: number,
    type?: 'songs' | 'artists' | 'albums' | 'playlists',
  ) =>
    get<SearchResults>(`${API_BASE}/search/all`, {
      keywords,
      limit,
      source,
      page,
      type,
    }),

  /** 艺术家详情：档案 + 热门单曲 + 专辑列表（`name` 供「无按-id 取艺术家」能力的源按名搜索）。 */
  artist: (source: MusicSource, id: string, name?: string) =>
    get<{ artist: Artist; tracks: Track[]; albums: Album[] }>(
      `${API_BASE}/artist/${source}/${encodeURIComponent(id)}`,
      { name },
    ),

  /** 专辑详情：档案 + 曲目。 */
  album: (source: MusicSource, id: string) =>
    get<{ album: Album; tracks: Track[] }>(
      `${API_BASE}/album/${source}/${encodeURIComponent(id)}`,
    ),

  /** 某源支持的发现能力：`{ recommend, playlists, toplists }`（供前端隐藏不支持的 tab）。 */
  discoverCapabilities: (source: MusicSource) =>
    get<{ recommend: boolean; playlists: boolean; toplists: boolean }>(
      `${API_BASE}/discover/capabilities`,
      {
        source,
      },
    ),

  recommend: (source: MusicSource, limit = 12) =>
    get<Playlist[]>(`${API_BASE}/discover/recommend`, { limit, source }),

  toplists: (source: MusicSource, limit = 50) =>
    get<Playlist[]>(`${API_BASE}/discover/toplists`, { limit, source }),

  playlists: (source: MusicSource, limit = 12, cat = '全部') =>
    get<Playlist[]>(`${API_BASE}/discover/playlists`, { limit, cat, source }),

  /** 「新歌精选」：发现流的一个纵向分区。 */
  newSongs: (source: MusicSource, limit = 20) =>
    get<Track[]>(`${API_BASE}/discover/new-songs`, { limit, source }),

  /** 「正在流行中」：热歌榜曲目，按热度排序（发现流的一个纵向分区）。 */
  hotSongs: (source: MusicSource, limit = 24) =>
    get<Track[]>(`${API_BASE}/discover/hot-songs`, { limit, source }),

  /** 歌单分类标签（搜索页的流派快捷入口）。 */
  categories: (source: MusicSource) =>
    get<PlaylistCategoryGroup[]>(`${API_BASE}/discover/categories`, {
      source,
    }),
  /** 「本周新发行」：最近发布的专辑。 */
  newAlbums: (source: MusicSource, limit = 12) =>
    get<Album[]>(`${API_BASE}/discover/new-albums`, { limit, source }),

  /** 歌单详情；对磁带渠道（B 站）而言返回该**磁带**与它的分P 曲目（见 ADR-044）。 */
  playlist: (source: MusicSource, id: string) =>
    get<{ playlist: Playlist; tracks: Track[] }>(
      `${API_BASE}/playlist/${source}/${encodeURIComponent(id)}`,
    ),

  songs: (source: MusicSource, ids: string[]) =>
    get<Track[]>(`${API_BASE}/songs`, { ids: ids.join(','), source }),

  /** 把一个视频 / 曲目展开为多个可播放条目（如 B 站分P 的一对多映射）。 */
  parts: (source: MusicSource, id: string) =>
    get<Track[]>(`${API_BASE}/parts/${source}/${encodeURIComponent(id)}`),

  lyric: (source: MusicSource, id: string) =>
    get<Lyric>(`${API_BASE}/lyric/${source}/${encodeURIComponent(id)}`),

  /** 某曲在给定档位下**实际**得到的音质（含降级）；`null` 表示不可播放 / 无法解析。 */
  quality: (source: MusicSource, id: string, level: AudioLevel) =>
    get<AudioQuality | null>(
      `${API_BASE}/quality/${source}/${encodeURIComponent(id)}`,
      { level },
    ),

  authStatus: (source: MusicSource) =>
    get<LoginStatus>(`${API_BASE}/auth/${source}/status`),

  qrCreate: (source: MusicSource) =>
    get<{ key: string; qrimg: string }>(`${API_BASE}/auth/${source}/qr`),

  qrCheck: (source: MusicSource, key: string) =>
    get<LoginStatus & { code?: number; message?: string }>(
      `${API_BASE}/auth/${source}/qr/check`,
      { key },
    ),

  logout: (source: MusicSource) =>
    post<LoginStatus>(`${API_BASE}/auth/${source}/logout`),

  userPlaylists: (uid?: string) =>
    get<Playlist[]>(`${API_BASE}/user/playlists`, { uid }),

  /** 读取本人 library 的云端副本；`payload` 为 null 表示云端尚无数据。 */
  syncGet: () =>
    get<{ payload: SyncEnvelope | null }>(`${API_BASE}/sync/library`),

  /** 覆盖写入本人 library 的云端副本（整文档）；返回服务端指派版本后的封套。 */
  syncPut: (state: LibraryData) =>
    put<SyncEnvelope>(`${API_BASE}/sync/library`, { state }),

  /* ------------------------- 翻录（实体直刻，见 ADR-048） ------------------------- */

  /**
   * 后端直刻能力（刻录机 / 介质 / ffmpeg / 平台）。
   * 仅同机（回环）访问可用——远端请求后端回 403。
   */
  ripCapabilities: () => get<RipCapabilities>(`${API_BASE}/rip/capabilities`),

  /** 发起一次实体刻录（异步任务，202 返回 jobId；进度经 SSE `/api/rip/events`）。 */
  ripBurn: (body: RipBurnRequestBody) =>
    post<{ jobId: string }>(`${API_BASE}/rip/burn`, body),

  /** 当前任务快照与最近终态（SSE 断线的兜底轮询）。 */
  ripStatus: () =>
    get<{ job: RipJobSnapshot | null; last: RipLastResult | null }>(
      `${API_BASE}/rip/status`,
    ),
}

export type Api = typeof api
