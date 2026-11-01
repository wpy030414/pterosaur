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

/**
 * 接口错误：调用方按 `status` / `needLogin` 区分处理，而不是去匹配错误文案。
 *
 * 此前 GET 与写请求各自构造一个裸 `Error` 并挂零散字段，写请求**不设 `status`**，
 * 于是「401 未登录」与「502 上游故障」在调用方看来没有区别。
 */
export class ApiError extends Error {
  readonly status: number
  readonly needLogin: boolean

  constructor(message: string, status: number, needLogin = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.needLogin = needLogin
  }
}

type Query = Record<string, string | number | undefined>

/**
 * 统一的请求入口：拼 URL、带凭证、解析 `ApiResult`、统一抛 {@link ApiError}。
 *
 * - 路径一律相对同源（开发期由 Vite 代理、生产由同一 Hono 进程提供），
 *   不再混用「`new URL(path, origin)`」与「相对路径」两种解析方式；
 * - 非 JSON / 非预期形状的响应也被归一成 `ApiError`，调用方无需再判断。
 */
async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  init: { query?: Query; body?: unknown } = {},
): Promise<T> {
  // GET 不得携带 body：只在写请求上设置，避免出现非法 fetch 选项
  const hasBody = init.body !== undefined && method !== 'GET'
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      ...(hasBody
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(init.body),
          }
        : {}),
    })
  } catch {
    // 断网 / 请求被取消：统一为 0 状态，调用方据「非 4xx/5xx」处理
    throw new ApiError('网络不可用，请检查连接', 0)
  }

  const json = (await res.json().catch(() => null)) as ApiResult<T> | null
  // `ok:true` 但缺 `data` 的畸形响应同样视为失败，避免把 undefined 当数据返回
  if (!json || !json.ok || json.data === undefined) {
    throw new ApiError(
      json?.error ?? `请求失败（${res.status}）`,
      res.status,
      json?.needLogin ?? false,
    )
  }
  return json.data
}

function get<T>(path: string, query?: Query): Promise<T> {
  return request<T>('GET', withQuery(path, query))
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, { body })
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, { body })
}

/** 把查询参数拼到路径上（空值 / `undefined` 一律省略）。 */
function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/** 批量 id 的分隔符（后端 `/api/songs` 按逗号切分）。id 自身不含逗号。 */
const ID_SEPARATOR = ','

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
      { source },
    ),

  recommend: (source: MusicSource, limit = 12) =>
    get<Playlist[]>(`${API_BASE}/discover/recommend`, { limit, source }),

  toplists: (source: MusicSource, limit = 50) =>
    get<Playlist[]>(`${API_BASE}/discover/toplists`, { limit, source }),

  playlists: (source: MusicSource, limit = 12, cat = '全部', page = 1) =>
    get<Playlist[]>(`${API_BASE}/discover/playlists`, {
      limit,
      cat,
      page,
      source,
    }),

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

  /**
   * 批量曲目详情。**先按逗号拼接、再整体交给 `withQuery` 编码**：
   * 若逐个 `encodeURIComponent` 后再拼接，含逗号的 id 会被编码成 `%2C`、与其他 id
   * 粘连，后端再按逗号切分时就成了一个错 id。上游 id 本身不含逗号。
   */
  songs: (source: MusicSource, ids: string[]) =>
    get<Track[]>(`${API_BASE}/songs`, { ids: ids.join(ID_SEPARATOR), source }),

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

  /** 用粘贴的 cookie 登录（后端校验后下发会话 cookie）；cookie 失效时抛 401 ApiError。 */
  cookieLogin: (source: MusicSource, cookie: string) =>
    post<LoginStatus>(`${API_BASE}/auth/${source}/cookie`, { cookie }),

  logout: (source: MusicSource) =>
    post<LoginStatus>(`${API_BASE}/auth/${source}/logout`),

  userPlaylists: (uid?: string) =>
    get<Playlist[]>(`${API_BASE}/user/playlists`, { uid }),

  /* ------------------------- 云同步 ------------------------- */

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
