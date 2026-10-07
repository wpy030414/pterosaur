import type {
  Album,
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

  /** 多类型搜索：并行返回歌曲 / 艺人 / 专辑 / 歌单；`page` 供滚动续取，`type` 限定只跑一类。 */
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

  /** 艺人详情：档案 + 热门单曲 + 专辑列表（`name` 供「无按-id 取歌手」能力的源按名搜索）。 */
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

  playlist: (source: MusicSource, id: string) =>
    get<{ playlist: Playlist; tracks: Track[] }>(
      `${API_BASE}/playlist/${source}/${encodeURIComponent(id)}`,
    ),

  songs: (source: MusicSource, ids: string[]) =>
    get<Track[]>(`${API_BASE}/songs`, { ids: ids.join(','), source }),

  /** 把一个视频 / 曲目展开为多个可播放条目（如 B 站分P 视频的一对多映射）。 */
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
}

export type Api = typeof api
