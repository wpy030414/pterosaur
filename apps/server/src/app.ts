import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import { adapterOf } from './sources/index.js'
import type { SourceAdapter } from './sources/types.js'
import { defineQueryRoute, defineSegRoute } from './sources/route.js'
import { sseChannel } from './sse.js'
import type { RipEvent } from '@pterosaur/shared/rip'
import {
  audioLevelOrDefault,
  ALL_SOURCES,
  type AudioQuality,
  type LoginStatus,
  type Playlist,
  type Track,
  type Lyric,
  type SyncEnvelope,
  type Artist,
  type Album,
  type PlaylistCategoryGroup,
  type SearchResults,
} from '@pterosaur/shared/types'
import { isLibraryState, readLibrary, writeLibrary } from './syncStore.js'
import { broadcast, subscribe } from './syncEvents.js'
import {
  UA,
  audioContentTypeFromUrl,
  fetchAudioCandidate,
} from './audioFetch.js'
import { isFakeBurn } from './imapi.js'
import { createRipEngine, validateBurnBody, type RipEngine } from './rip.js'
import { failure, onError } from './errors.js'
import {
  cacheKey,
  clearCookies,
  cached,
  cookieOf,
  credentialOf,
  credentialKey,
  ctxAdapter,
  fail,
  forwardSessionCookies,
  ok,
  parseLimit,
  parsePage,
  qualityCache,
  requireIdentity,
  requireLoopback,
  sourceQuery,
  syncKey,
  urlCache,
} from './http.js'

// 单测经 app.js 观察 / 重置结构化数据缓存（保持既有导入路径）
export { dataCache, DATA_CACHE_TTL_MS } from './http.js'

/** `/api/search/all` 允许的 `type` 取值（与返回字段一一对应）。 */
const SEARCH_TYPES = new Set(['songs', 'artists', 'albums', 'playlists'])
type SearchType = 'songs' | 'artists' | 'albums' | 'playlists'

/**
 * 注册 `/api/<name>/:source/:id` 与其 2 段式别名 `/api/<name>/:id`
 * （缺省源，兼容旧页面 / 旧 SW 外壳缓存）。
 */
function segRoute(
  app: Hono,
  name: string,
  handler: (c: Context) => Promise<Response>,
) {
  app.get(`/api/${name}/:source/:id`, handler)
  app.get(`/api/${name}/:id`, handler)
}

/**
 * 音频流代理处理器：`GET|HEAD /stream/:id`。
 *
 * 浏览器 `<audio>` 直接请求本地址；服务端解析真实 CDN 地址、改写为 https，
 * 再按客户端 Range 转发到上游 CDN，从而规避混合内容与跨域限制。
 */
async function streamHandler(c: Context): Promise<Response> {
  // 2 段式 `/stream/:id` 视为缺省源（兼容旧页面 / 旧 SW 缓存）；3 段式显式带源。
  const ctx = ctxAdapter(c)
  if (!ctx) return c.json(fail('未知音源'), 404)
  const { source, adapter } = ctx

  const id = c.req.param('id') ?? ''
  const level = audioLevelOrDefault(c.req.query('level'))
  const cookie = credentialOf(c, adapter)

  const key = `${source}|${id}|${level}|${credentialKey(cookie)}`
  let urls = urlCache.get(key)
  if (!urls) {
    const resolved = await adapter.songUrl(id, cookie, level)
    if (resolved.length) {
      urls = resolved
      urlCache.set(key, resolved)
    }
  }

  if (!urls || urls.length === 0) {
    // VIP 曲目未登录 / 版权受限 / 解析失败：返回 403 并置 needLogin
    return c.json(fail('该曲目暂不可播放', true), 403)
  }

  const range = c.req.header('range')
  const upstreamHeaders: Record<string, string> = {
    'User-Agent': UA,
    ...adapter.streamHeaders?.(id),
  }
  if (range) upstreamHeaders['Range'] = range

  // 依次尝试候选地址（B 站等源的直链含多个 CDN 镜像，单节点故障不应直接判死）；
  // 候选轮换 / 连接超时 / 丢弃重试的韧性逻辑收敛在 audioFetch.fetchAudioCandidate，
  // 与翻录直刻模块共用同一实现。
  const fetched = await fetchAudioCandidate(urls, upstreamHeaders)
  if (!fetched) {
    // 全部候选失败（地址过期 / 节点故障）：淘汰缓存，下次请求重新解析
    urlCache.delete(key)
    return c.json(fail('音频源不可用'), 502)
  }
  const upstream = fetched.res
  const usedUrl = fetched.usedUrl

  // 命中的非首位候选提到队首，下次直接先用它，避免反复白撞已知坏节点
  if (usedUrl !== urls[0]) {
    urlCache.set(key, [usedUrl, ...urls.filter((u) => u !== usedUrl)])
  }

  const headers = new Headers()
  headers.set(
    'Content-Type',
    audioContentTypeFromUrl(usedUrl) ??
      upstream.headers.get('content-type') ??
      'audio/mpeg',
  )
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers.set('Content-Range', contentRange)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'no-store')

  const status = upstream.status === 206 ? 206 : 200
  // HEAD 请求不返回 body
  return new Response(c.req.method === 'HEAD' ? null : upstream.body, {
    status,
    headers,
  })
}

/**
 * 组装应用。
 *
 * `rip` 可由调用方注入（单测据此持有自己的刻录引擎实例、与其它 app 天然隔离）；
 * 缺省新建一份——生产由 `index.ts` 调用，全进程一份。
 */
export function createApp({
  rip = createRipEngine(),
}: { rip?: RipEngine } = {}) {
  const app = new Hono()
  app.onError(onError)

  // 同源部署；开发期由 Vite 代理转发（同源），本无需 CORS。保留一段宽松策略仅为
  // 本地联调便利，但**不能**用 `origin:'*'` + `credentials:true`——那是浏览器明令拒绝的
  // 组合（此类请求根本不会带上 cookie，却又被迫走预检）。故按请求 Origin 回显。
  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin || undefined,
      allowHeaders: ['Content-Type'],
      credentials: true,
    }),
  )

  app.get('/api/health', (c) => c.json(ok({ status: 'ok', time: Date.now() })))

  /* ============================ 发现 / 搜索 ============================ */

  app.get('/api/search', async (c) => {
    const keywords = (c.req.query('keywords') ?? c.req.query('s') ?? '').trim()
    if (!keywords) return c.json(fail('缺少搜索关键词'), 400)
    // 缺省 30、收口 60；键与实参共用同一个归一化值
    const limit = parseLimit(c.req.query('limit'), 30, 60)
    const page = parsePage(c.req.query('page'))
    const source = sourceQuery(c)
    const adapter = adapterOf(source)
    if (!adapter) return c.json(fail('未知音源'), 404)
    const cred = credentialOf(c, adapter)
    try {
      const tracks = await cached(
        cacheKey(source, 'search', [keywords, limit, page], cred),
        () => adapter.searchSongs(keywords, limit, cred, page),
      )
      return c.json(ok<Track[]>(tracks))
    } catch (e) {
      throw failure(502, '搜索失败', e)
    }
  })

  /**
   * 多类型搜索：并行返回歌曲 / 艺术家 / 专辑 / 歌单。
   *
   * 每类条数统一取请求的 `limit`（收口 1–50，缺省 20）——主搜索页要歌曲 32 条、
   * 其余分区 20 条，独立类别页续页时也按同一口径判断「是否还有下一批」。
   * `page`（从 1 起）供前端滚动续取下一批；`type` 可**只跑某一类**（省掉其余三类上游请求，
   * 供独立类别页续取下一页用），未指定时四类全跑；**未知 `type` 回 400**——否则会生成并
   * 缓存一份「四类全空」的结果。`capabilities` 由适配器的静态能力决定，随结果一起缓存。
   */
  app.get('/api/search/all', async (c) => {
    const keywords = (c.req.query('keywords') ?? '').trim()
    if (!keywords) return c.json(fail('缺少搜索关键词'), 400)
    const limit = parseLimit(c.req.query('limit'), 20, 50)
    const page = parsePage(c.req.query('page'))
    const only = c.req.query('type') ?? ''
    if (only && !SEARCH_TYPES.has(only))
      return c.json(fail(`未知的搜索类型：${only}`), 400)
    const source = sourceQuery(c)
    const adapter = adapterOf(source)
    if (!adapter) return c.json(fail('未知音源'), 404)
    const cred = credentialOf(c, adapter)
    const want = (t: SearchType) => !only || only === t
    try {
      const result = await cached<SearchResults>(
        cacheKey(source, 'search-all', [keywords, limit, page, only], cred),
        async () => {
          const [songs, artists, albums, playlists] = await Promise.all([
            want('songs')
              ? adapter.searchSongs(keywords, limit, cred, page)
              : Promise.resolve([] as Track[]),
            want('artists') && adapter.searchArtists
              ? adapter.searchArtists(keywords, limit, cred, page)
              : Promise.resolve([] as Artist[]),
            want('albums') && adapter.searchAlbums
              ? adapter.searchAlbums(keywords, limit, cred, page)
              : Promise.resolve([] as Album[]),
            want('playlists') && adapter.searchPlaylists
              ? adapter.searchPlaylists(keywords, limit, cred, page)
              : Promise.resolve([] as Playlist[]),
          ])
          const capabilities = {
            songs: true,
            artists: Boolean(adapter.searchArtists),
            albums: Boolean(adapter.searchAlbums),
            playlists: Boolean(adapter.searchPlaylists),
          }
          return { songs, artists, albums, playlists, capabilities }
        },
      )
      return c.json(ok(result))
    } catch (e) {
      throw failure(502, '搜索失败', e)
    }
  })

  /** 某源支持的发现能力（供前端隐藏不支持的 tab）。 */
  app.get('/api/discover/capabilities', (c) => {
    const adapter = adapterOf(sourceQuery(c))
    if (!adapter) return c.json(fail('未知音源'), 404)
    return c.json(
      ok({
        recommend: Boolean(adapter.recommendPlaylists),
        playlists: Boolean(adapter.topPlaylists),
        toplists: Boolean(adapter.toplists),
      }),
    )
  })

  app.get(
    '/api/discover/recommend',
    defineQueryRoute<Playlist[]>(
      'recommend',
      {
        unsupported: '该音源暂不支持推荐',
        errorLabel: '获取推荐失败',
        params: (c) => [parseLimit(c.req.query('limit'), 12, 50)],
      },
      (a) => Boolean(a.recommendPlaylists),
      ({ adapter, params }, cred) =>
        adapter.recommendPlaylists!(Number(params[0]), cred),
    ),
  )

  app.get(
    '/api/discover/toplists',
    defineQueryRoute<Playlist[]>(
      'toplists',
      {
        unsupported: '该音源暂不支持排行榜',
        errorLabel: '获取排行榜失败',
        params: (c) => [parseLimit(c.req.query('limit'), 50, 50)],
      },
      (a) => Boolean(a.toplists),
      ({ adapter, params }, cred) => adapter.toplists!(Number(params[0]), cred),
    ),
  )

  app.get(
    '/api/discover/playlists',
    defineQueryRoute<Playlist[]>(
      'top-playlists',
      {
        unsupported: '该音源暂不支持精品歌单',
        errorLabel: '获取歌单失败',
        params: (c) => [
          parseLimit(c.req.query('limit'), 12, 50),
          c.req.query('cat') ?? '全部',
          parsePage(c.req.query('page')),
        ],
      },
      (a) => Boolean(a.topPlaylists),
      ({ adapter, params }, cred) =>
        adapter.topPlaylists!(
          Number(params[0]),
          String(params[1]),
          Number(params[2]),
          cred,
        ),
    ),
  )

  /** 「新歌精选」：发现流的纵向分区之一（见 ADR-049）。 */
  app.get(
    '/api/discover/new-songs',
    defineQueryRoute<Track[]>(
      'new-songs',
      {
        unsupported: '该音源暂不支持新歌',
        errorLabel: '获取新歌失败',
        params: (c) => [parseLimit(c.req.query('limit'), 20, 50)],
      },
      (a) => Boolean(a.newSongs),
      ({ adapter, params }, cred) => adapter.newSongs!(Number(params[0]), cred),
    ),
  )

  /** 「正在流行中」：热歌榜曲目（发现流的一个纵向分区）。 */
  app.get(
    '/api/discover/hot-songs',
    defineQueryRoute<Track[]>(
      'hot-songs',
      {
        unsupported: '该音源暂不支持热门歌曲',
        errorLabel: '获取热歌失败',
        // hotSongs 不接收凭证；仍走统一键（凭证指纹恒为访客自身），不特殊化
        params: (c) => [parseLimit(c.req.query('limit'), 24, 50)],
      },
      (a) => Boolean(a.hotSongs),
      ({ adapter, params }) => adapter.hotSongs!(Number(params[0])),
    ),
  )

  /** 歌单分类标签（搜索页的流派快捷入口）。 */
  app.get(
    '/api/discover/categories',
    defineQueryRoute<PlaylistCategoryGroup[]>(
      'categories',
      {
        unsupported: '该音源暂不支持分类',
        errorLabel: '获取分类失败',
        params: () => [],
      },
      (a) => Boolean(a.playlistCategories),
      ({ adapter }, cred) => adapter.playlistCategories!(cred),
    ),
  )

  /** 「本周新发行」：最近发布的专辑。 */
  app.get(
    '/api/discover/new-albums',
    defineQueryRoute<Album[]>(
      'new-albums',
      {
        unsupported: '该音源暂不支持新专辑',
        errorLabel: '获取新专辑失败',
        params: (c) => [parseLimit(c.req.query('limit'), 12, 50)],
      },
      (a) => Boolean(a.newAlbums),
      ({ adapter, params }, cred) =>
        adapter.newAlbums!(Number(params[0]), cred),
    ),
  )

  /* ============================ 详情（命中 / 歌词 / 音质） ============================ */

  segRoute(
    app,
    'playlist',
    defineSegRoute<{ playlist: Playlist; tracks: Track[] }>(
      'playlist',
      { unsupported: '该音源暂不支持歌单页', errorLabel: '获取歌单详情失败' },
      (a) => Boolean(a.playlistTracks),
      ({ adapter, id }, cred) => adapter.playlistTracks!(id, cred),
    ),
  )

  segRoute(
    app,
    'artist',
    defineSegRoute<
      Awaited<ReturnType<NonNullable<SourceAdapter['artistDetail']>>>
    >(
      'artist',
      {
        unsupported: '该音源暂不支持艺术家页',
        errorLabel: '获取艺术家详情失败',
        params: (c) => [c.req.query('name')],
      },
      (a) => Boolean(a.artistDetail),
      ({ adapter, id, params }, cred) =>
        adapter.artistDetail!(id, cred, params[0] as string | undefined),
    ),
  )

  segRoute(
    app,
    'album',
    defineSegRoute<Awaited<ReturnType<SourceAdapter['albumDetail']>>>(
      'album',
      { unsupported: '该音源暂不支持专辑页', errorLabel: '获取专辑详情失败' },
      () => true,
      ({ adapter, id }, cred) => adapter.albumDetail(id, cred),
    ),
  )

  app.get('/api/songs', async (c) => {
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!ids.length) return c.json(fail('缺少 ids'), 400)
    const capped = ids.slice(0, 200)
    const source = sourceQuery(c)
    const adapter = adapterOf(source)
    if (!adapter) return c.json(fail('未知音源'), 404)
    if (!adapter.songDetail) return c.json(fail('该音源暂不支持批量曲目'), 501)
    const cred = credentialOf(c, adapter)
    try {
      const tracks = await cached(
        cacheKey(source, 'songs', [capped.join(',')], cred),
        () => adapter.songDetail!(capped, cred),
      )
      return c.json(ok<Track[]>(tracks))
    } catch (e) {
      throw failure(502, '获取曲目详情失败', e)
    }
  })

  /** 把一个视频 / 曲目展开为多个可播放条目（如 B 站分P 视频的一对多映射）。 */
  segRoute(
    app,
    'parts',
    defineSegRoute<Track[]>(
      'parts',
      { unsupported: '该音源暂不支持拆分', errorLabel: '获取分P失败' },
      (a) => Boolean(a.parts),
      ({ adapter, id }, cred) => adapter.parts!(id, cred),
    ),
  )

  segRoute(
    app,
    'lyric',
    // 凭证指纹进键是硬要求：B 站字幕**匿名恒空、登录才可见**，不隔离则登录后仍命中空歌词
    defineSegRoute<Lyric>(
      'lyric',
      { unsupported: '该音源暂不支持歌词', errorLabel: '获取歌词失败' },
      () => true,
      ({ adapter, id }, cred) => adapter.getLyric(id, cred),
    ),
  )

  /**
   * 查询某曲在给定档位下**实际**得到的音质（含服务端降级），供沉浸页音质 chip。
   * 结果按 `源|id|档位|凭证指纹` 缓存（与音频地址缓存同 TTL），避免每次重开沉浸页都重解析。
   */
  segRoute(app, 'quality', async (c) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    if (!ctx.adapter.audioQuality)
      return c.json(fail('该音源暂不支持音质查询'), 501)
    const id = c.req.param('id') ?? ''
    const level = audioLevelOrDefault(c.req.query('level'))
    const cookie = credentialOf(c, ctx.adapter)
    const key = `${ctx.source}|quality|${id}|${level}|${credentialKey(cookie)}`
    const hit = qualityCache.get(key)
    if (hit) return c.json(ok<AudioQuality>(hit))
    try {
      const quality = await ctx.adapter.audioQuality(id, cookie, level)
      if (quality) qualityCache.set(key, quality)
      return c.json(ok<AudioQuality | null>(quality))
    } catch (e) {
      throw failure(502, '获取音质失败', e)
    }
  })

  /* ============================ 登录 / VIP ============================ */

  /**
   * 登录态查询。除返回登录信息，还承担一次**会话自愈**：访客带了该源的会话 cookie、却被判为
   * **未登录**（即 cookie 已失效），就下发 Set-Cookie 清空该源**全部**会话 cookie。否则这些残留
   * 会让后续内容请求的 `credentialOf` 认定「访客有自己的会话」而**绕开服务端缺省凭证**，把 VIP
   * 曲目打回 30 秒试听（见 `credentialOf`）。
   *
   * 仅当 `loginStatus` **正常返回**未登录时清理；上游异常走 catch，不下发 cookie 以避免误登出。
   * 注意个别适配器会把瞬时上游故障也表达为 `{ logged: false }`，故本清理非绝对精确，属尽力而为。
   */
  const authStatusHandler = async (c: Context) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    // 该源是否支持登录（有扫码能力）——前端据此隐藏登录入口
    const loginable = Boolean(ctx.adapter.qrKey)
    const presented = cookieOf(c, ctx.adapter)
    try {
      const status = await ctx.adapter.loginStatus(presented)
      // 带了会话 cookie 却判定未登录 → 清掉失效残留，让后续请求回落到缺省凭证
      if (!status.logged && presented)
        clearCookies(c, ctx.adapter.sessionCookieNames)
      return c.json(ok<LoginStatus>({ ...status, loginable }))
    } catch {
      return c.json(ok<LoginStatus>({ logged: false, loginable }))
    }
  }
  app.get('/api/auth/:source/status', authStatusHandler)
  app.get('/api/auth/status', authStatusHandler)

  /** 生成二维码：返回 key 与 base64 图片，前端凭 key 轮询 `/qr/check`。 */
  const authQrHandler = async (c: Context) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    if (!ctx.adapter.qrKey || !ctx.adapter.qrCreate)
      return c.json(fail('该音源暂不支持登录'), 501)
    try {
      const cookie = cookieOf(c, ctx.adapter)
      const key = await ctx.adapter.qrKey(cookie)
      if (!key) return c.json(fail('无法生成登录二维码'), 502)
      const qrimg = await ctx.adapter.qrCreate(key, cookie)
      return c.json(ok({ key, qrimg }))
    } catch (e) {
      throw failure(502, '生成二维码失败', e)
    }
  }
  app.get('/api/auth/:source/qr', authQrHandler)
  app.get('/api/auth/qr', authQrHandler)

  /**
   * 轮询扫码状态。803 成功时下发 Set-Cookie 建立会话，并返回登录档案。
   * 其余状态码（800/801/802）仅返回状态，不下发 cookie。
   */
  const authQrCheckHandler = async (c: Context) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    if (!ctx.adapter.qrCheck) return c.json(fail('该音源暂不支持登录'), 501)
    const key = c.req.query('key')
    if (!key) return c.json(fail('缺少 key'), 400)
    try {
      const { code, cookies, message } = await ctx.adapter.qrCheck(
        key,
        cookieOf(c, ctx.adapter),
      )
      if (code !== 803) {
        return c.json(ok({ code, logged: false, message }))
      }
      const cookieHeader = ctx.adapter.cookieHeaderFromSetCookies(cookies)
      const status = await ctx.adapter.loginStatus(cookieHeader)
      forwardSessionCookies(c, ctx.adapter, cookies)
      // 单活动账号：登入某源时清掉**其它源**的会话 cookie（含磁带渠道，见 ADR-027）
      for (const other of ALL_SOURCES) {
        if (other === ctx.source) continue
        const oa = adapterOf(other)
        if (oa) clearCookies(c, oa.logoutCookieNames)
      }
      return c.json(
        ok<LoginStatus & { code: number; message?: string }>({
          ...status,
          // 与 `/api/auth/:source/status` 一致：带上 `loginable`，否则前端写入登录态时会丢该字段、
          // 把该源从登录弹窗的 tab 列表里滤掉（「登录后再点登录就没有这个源了」）。
          loginable: Boolean(ctx.adapter.qrKey),
          code,
          message,
        }),
      )
    } catch (e) {
      throw failure(502, '检查登录状态失败', e)
    }
  }
  app.get('/api/auth/:source/qr/check', authQrCheckHandler)
  app.get('/api/auth/qr/check', authQrCheckHandler)

  const authLogoutHandler = (c: Context) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    clearCookies(c, ctx.adapter.logoutCookieNames)
    return c.json(ok<LoginStatus>({ logged: false }))
  }
  app.post('/api/auth/:source/logout', authLogoutHandler)
  app.post('/api/auth/logout', authLogoutHandler)

  /**
   * 用户歌单（登录者自己的收藏列表）。**不进结构化数据缓存**：私有数据、
   * 随用户收藏操作即时变化，缓存收益低而串新旧的风险高（见 ADR-042 的排除清单）。
   */
  app.get('/api/user/playlists', async (c) => {
    const netease = adapterOf('netease')
    if (!netease?.userPlaylists)
      return c.json(fail('该音源暂不支持用户歌单'), 501)
    const cookie = cookieOf(c, netease)
    const uid = c.req.query('uid')
    try {
      if (!uid) {
        const st = await netease.loginStatus(cookie)
        if (!st.logged || !st.userId) return c.json(fail('未登录', true), 401)
        return c.json(
          ok<Playlist[]>(await netease.userPlaylists(st.userId, cookie)),
        )
      }
      return c.json(ok<Playlist[]>(await netease.userPlaylists(uid, cookie)))
    } catch (e) {
      throw failure(502, '获取用户歌单失败', e)
    }
  })

  /* ============================ 云同步 ============================ */

  /**
   * 读取本人 library 的云端副本。以访客本人 cookie 判定身份（未登录 401）。
   * 返回 `{ payload }`：`null` 表示云端尚无数据（首次开启同步）。
   */
  app.get('/api/sync/library', async (c) => {
    const identity = await requireIdentity(c)
    if (!identity) return c.json(fail('未登录', true), 401)
    try {
      const read = readLibrary(syncKey(identity))
      // 「损坏」绝不能报成「没有」：客户端会把「没有」当成「以本地为准并上传」，
      // 从而用本地空库覆盖云端副本（见 syncStore.ReadResult）
      if (read.kind === 'corrupt')
        return c.json(fail(`云端副本损坏：${read.reason}`), 502)
      return c.json(
        ok<{ payload: SyncEnvelope | null }>({
          payload: read.kind === 'ok' ? read.envelope : null,
        }),
      )
    } catch (e) {
      throw failure(502, '读取云同步失败', e)
    }
  })

  /**
   * 覆盖写入本人 library 的云端副本（整文档覆盖）。
   * 版本号 / 写入时刻由**服务端**指派；成功后向同一账号的其它连接广播 `{ rev }`（SSE）。
   */
  app.put('/api/sync/library', async (c) => {
    const identity = await requireIdentity(c)
    if (!identity) return c.json(fail('未登录', true), 401)
    const body: unknown = await c.req.json().catch(() => null)
    const state = (body as { state?: unknown } | null)?.state
    if (!isLibraryState(state)) return c.json(fail('同步载荷非法'), 400)
    const key = syncKey(identity)
    try {
      const saved = await writeLibrary(key, state)
      broadcast(key, { rev: saved.rev ?? 0 })
      return c.json(ok<SyncEnvelope>(saved))
    } catch (e) {
      throw failure(400, '写入云同步失败', e)
    }
  })

  /** 云同步的实时版本信号（SSE）。以访客本人 cookie 判定身份。 */
  app.get('/api/sync/events', async (c) => {
    const identity = await requireIdentity(c)
    if (!identity) return c.json(fail('未登录', true), 401)
    return sseChannel(c, (stream) => subscribe(syncKey(identity), stream))
  })

  /* ============================ 翻录（实体直刻） ============================ */

  /*
   * 直刻操作的是**后端所在设备**的光驱，故以下路由全部经 `requireLoopback`
   * 硬门控：远端访问一律 403（见 ADR-048）。
   */

  /** 直刻能力（刻录机 / 介质 / ffmpeg / 平台）。 */
  app.get('/api/rip/capabilities', async (c) => {
    if (!requireLoopback(c)) return c.json(fail('仅支持本机访问'), 403)
    try {
      return c.json(ok(await rip.ripCapabilities()))
    } catch (e) {
      return c.json(
        fail(e instanceof Error ? e.message : '刻录能力探测失败'),
        502,
      )
    }
  })

  /** 当前刻录任务快照与最近终态（SSE 断线的兜底轮询）。 */
  app.get('/api/rip/status', (c) => {
    if (!requireLoopback(c)) return c.json(fail('仅支持本机访问'), 403)
    return c.json(
      ok({ job: rip.jobSnapshot(), last: rip.lastResultSnapshot() }),
    )
  })

  /**
   * 刻录事件流（SSE）。连接建立后先发**快照帧**（当前任务 + 最近终态），
   * 消除「订阅晚于任务启动 / 任务刚结束」的竞态；随后转发任务事件。
   */
  app.get('/api/rip/events', async (c) => {
    if (!requireLoopback(c)) return c.json(fail('仅支持本机访问'), 403)
    return sseChannel(
      c,
      (stream) => {
        const unsubscribe = rip.subscribe((ev) => {
          void stream
            .writeSSE({ event: 'message', data: JSON.stringify(ev) })
            .catch(() => {
              /* 连接已断开：交给 onAbort 清理 */
            })
        })
        return unsubscribe
      },
      (): RipEvent => ({
        type: 'state',
        job: rip.jobSnapshot(),
        last: rip.lastResultSnapshot(),
      }),
    )
  })

  /**
   * 发起一次实体刻录（`{ meta, tracks, discType, level }`）。
   * 立即回 **202**（任务后台执行），进度经 `/api/rip/events` 下发；
   * 单任务：已有任务进行中回 409；非 Windows（且未开模拟刻录）回 501。
   */
  app.post('/api/rip/burn', async (c) => {
    if (!requireLoopback(c)) return c.json(fail('仅支持本机访问'), 403)
    const body: unknown = await c.req.json().catch(() => null)
    const validated = validateBurnBody(body)
    if (!validated.ok) return c.json(fail(validated.error), 400)
    if (process.platform !== 'win32' && !isFakeBurn())
      return c.json(fail('当前平台不支持直刻（仅 Windows）'), 501)
    const adapter = adapterOf(validated.value.tracks[0].source)
    if (!adapter) return c.json(fail('未知音源'), 404)
    const started = rip.startBurn({
      ...validated.value,
      credential: credentialOf(c, adapter),
    })
    // 单任务：并发由引擎同步占位保证（见 rip.createRipEngine），此处无 TOCTOU
    if ('busy' in started) return c.json(fail('已有刻录任务进行中'), 409)
    return c.json(ok({ jobId: started.id }), 202)
  })

  /* ============================ 音频流代理 ============================ */

  app.get('/stream/:source/:id', streamHandler)
  app.on('HEAD', '/stream/:source/:id', streamHandler)
  // 2 段式别名：兼容旧页面 / 旧 SW 外壳缓存（视为缺省源）。
  app.get('/stream/:id', streamHandler)
  app.on('HEAD', '/stream/:id', streamHandler)

  return app
}
