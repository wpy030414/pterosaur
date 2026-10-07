import type {
  Album,
  Artist,
  AudioLevel,
  AudioQuality,
  LoginStatus,
  Lyric,
  MusicSource,
  Playlist,
  Track,
} from '@pterosaur/shared/types'

/** 扫码轮询结果，`code` 沿用网易云契约：800 过期 / 801 等待 / 802 待确认 / 803 成功。 */
export interface QrCheckResult {
  code: number
  /** 成功时上游返回的原始 Set-Cookie 字符串数组。 */
  cookies?: string[]
  message?: string
}

/**
 * 音源适配器：把某个音源的私有 API 收敛为共享模型。
 *
 * 必选成员是「任何源都应具备」的播放公共面与登录态查询；可选成员代表「能力可缺」——
 * 路由层对缺失成员回 501、前端隐藏对应入口，从而允许新源先只实现一部分能力上线，
 * **包括「不支持登录」的源**（缺 `qrKey` 即视为无登录入口）。
 */
export interface SourceAdapter {
  readonly id: MusicSource
  /** 会话必需 cookie 名单：下发与回传均只处理这几项。无登录源可为空数组。 */
  readonly sessionCookieNames: readonly string[]
  /** 退出登录时需要下发的过期 cookie 名称。无登录源可为空数组。 */
  readonly logoutCookieNames: readonly string[]

  /* ---- 内容（必选） ---- */
  /** `page` 从 1 起（缺省 1），供搜索结果「滚动续取下一批」。 */
  searchSongs(
    keywords: string,
    limit: number,
    cred?: string,
    page?: number,
  ): Promise<Track[]>
  albumDetail(
    id: string,
    cred?: string,
  ): Promise<{ album: Album; tracks: Track[] }>
  /**
   * 解析播放地址，返回**有序候选**（首个优先；后端逐个尝试，前一候选失败才回退下一个）。
   * 空数组表示不可播放（版权受限 / 未登录 / 解析失败）。
   * `level` 为**抽象音质档位**（见 shared `AudioLevel`），各源自行映射/降级。
   */
  songUrl(id: string, cred?: string, level?: AudioLevel): Promise<string[]>
  /**
   * 解析给定档位下**实际**得到的音质（服务端降级后的真实档位 + 码率），供沉浸页音质 chip。
   * 缺省即该源不支持音质查询，路由回 501。返回 `null` 表示不可播放 / 无法解析。
   */
  audioQuality?(
    id: string,
    cred?: string,
    level?: AudioLevel,
  ): Promise<AudioQuality | null>
  getLyric(id: string, cred?: string): Promise<Lyric>

  /* ---- 登录（必选面） ---- */
  /** 查询登录态。无登录能力的源返回 `{ logged: false }` 即可。 */
  loginStatus(cred?: string): Promise<LoginStatus>
  cookieHeaderFromSetCookies(cookies?: string[]): string | undefined
  /** 音频 CDN 需要的附加上游请求头（如某些源的 CDN 要求 `Referer`）。 */
  streamHeaders?(id: string): Record<string, string>

  /* ---- 内容（可选能力） ---- */
  searchArtists?(
    keywords: string,
    limit: number,
    cred?: string,
    page?: number,
  ): Promise<Artist[]>
  searchAlbums?(
    keywords: string,
    limit: number,
    cred?: string,
    page?: number,
  ): Promise<Album[]>
  searchPlaylists?(
    keywords: string,
    limit: number,
    cred?: string,
    page?: number,
  ): Promise<Playlist[]>
  artistDetail?(
    id: string,
    cred?: string,
    name?: string,
  ): Promise<{ artist: Artist; tracks: Track[]; albums: Album[] }>
  playlistTracks?(
    id: string,
    cred?: string,
  ): Promise<{ playlist: Playlist; tracks: Track[] }>
  songDetail?(ids: string[], cred?: string): Promise<Track[]>

  /**
   * 把「一个视频 / 曲目」展开为多个可播放条目（如 B 站分P 视频的一对多映射）。
   * 缺省即该源无此概念，路由回 501。返回项的 `id` 需能被本源的 `songUrl` 解析。
   */
  parts?(id: string, cred?: string): Promise<Track[]>

  /* ---- 发现（可选能力；首页/浏览的推荐） ---- */
  recommendPlaylists?(limit: number, cred?: string): Promise<Playlist[]>
  toplists?(limit: number, cred?: string): Promise<Playlist[]>
  topPlaylists?(limit: number, cat?: string, cred?: string): Promise<Playlist[]>

  /* ---- 登录（可选能力：扫码） ---- */
  /**
   * 扫码登录三件套。**缺省即视为该源不支持登录**——`app.ts` 的 auth 路由据此回 501，
   * 前端据 `LoginStatus.loginable` 隐藏登录入口。
   */
  qrKey?(cred?: string): Promise<string>
  qrCreate?(key: string, cred?: string): Promise<string>
  qrCheck?(key: string, cred?: string): Promise<QrCheckResult>
  /** 生成二维码**内容 URL**（供终端自行渲染）。 */
  qrLoginUrl?(key: string, cred?: string): Promise<string>
  userPlaylists?(uid: string, cred?: string): Promise<Playlist[]>
}
