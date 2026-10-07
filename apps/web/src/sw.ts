/**
 * 应用 Service Worker（单一 SW，按匹配范围互不相交地承担三类职责）。
 *
 * 1. `/stream/*`（音频代理）：命中缓存按 `Range` 返回 200/206；未命中时仅**整文件请求**
 *    （无 `Range` / `bytes=0-` 前缀）单次下载整文件并写入 IndexedDB，其余 `Range`（seek）不接管、
 *    由浏览器直接请求同源接口（见 ADR-012 后续修订）。
 * 2. 封面图片（`destination === 'image'`）：命中缓存直接返回；未命中以 **CORS** 重新拉取
 *    （网易云 CDN 返回 `access-control-allow-origin: *`），把可读字节写入**同一个** IndexedDB
 *    池 —— 与音频**共享 16GB LRU 预算**（见 ADR-013）。封面自写入起 **7 天过期**：命中时若已过期
 *    则清除并回源，启动时亦清扫一遍（见 ADR-015）；音频不限时，仅受 LRU 淘汰。
 * 3. 应用外壳（仅生产）：导航 HTML 走 NetworkFirst、同源 script/style 走 StaleWhileRevalidate，
 *    缓存 7 天后过期（见 `lib/shellCache.ts`）；precache 只含静态图标/清单。
 *
 * 其余请求原样放行——因此对 `/api/*`、HMR 与其它资源零影响。
 * 浏览器 HTTP 缓存已由后端 `Cache-Control: no-store` 关闭，故缓存完全由本 SW 承担。
 *
 * 另：接受页面 `PREFETCH_AUDIO` 消息**主动**整段下载音频写入同一 IDB（预载队列相邻曲目，
 * 见 ADR-037）。SW 自身发起的 `fetch()` 不经其自身的 fetch 处理器，故该路径直连后端、不递归。
 */
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import {
  audioKey,
  type MediaMeta,
  CAP_BYTES,
  DEFAULT_LEVEL,
  deleteCached,
  effectiveCap,
  expiredKeys,
  getAllMeta,
  getCached,
  imageKey,
  isExpired,
  isWholeFileRange,
  isWholeFileResponse,
  pickEvictions,
  putCached,
  requestPersistentQuota,
  responseFromBlob,
  touchCached,
} from './lib/mediaCache.js'
import { registerShellRoutes } from './lib/shellCache.js'
import { parsePrefetchAudio, PREFETCH_AUDIO } from './lib/prefetchProtocol.js'
import {
  DEFAULT_SOURCE,
  isMusicSource,
  streamUrl,
  type AudioLevel,
  type MusicSource,
} from '@pterosaur/shared/types'

// —— 最小化 SW 全局类型声明：避免引入 `webworker` lib 与既有 `DOM` lib 产生重复标识符冲突 ——
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface FetchEventLike extends ExtendableEventLike {
  request: Request
  respondWith(response: Response | Promise<Response>): void
}
interface MessageEventLike extends Event {
  data: unknown
  /** `ExtendableMessageEvent` 的 waitUntil：把异步写入并入 SW 生命周期。 */
  waitUntil(promise: Promise<unknown>): void
}
interface ServiceWorkerGlobalScopeLike {
  addEventListener(
    type: 'install' | 'activate',
    listener: (e: ExtendableEventLike) => void,
  ): void
  addEventListener(type: 'fetch', listener: (e: FetchEventLike) => void): void
  addEventListener(
    type: 'message',
    listener: (e: MessageEventLike) => void,
  ): void
  readonly location: Location
  readonly clients: {
    claim(): Promise<void>
    matchAll(options?: {
      type?: string
      includeUncontrolled?: boolean
    }): Promise<{ postMessage(message: unknown): void }[]>
  }
  skipWaiting(): Promise<void>
}

const sw = globalThis as unknown as ServiceWorkerGlobalScopeLike

const STREAM_PREFIX = '/stream/'

/**
 * 音频回源的响应头超时（毫秒）。仅约束连接建立阶段——网络差时上游可能长时间
 * 不返回响应头而让 `<audio>` 的请求悬死（无 error、无数据）；超时即 abort，
 * 走既有 `Response.error()` 路径把故障显式暴露给页面。body 阶段不设整体超时：
 * 长音频在弱网下慢速下载属正常，交由播放侧看门狗与后端超时兜底。
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000

/** 内存中的元数据索引（轻量，不含 blob），用于 LRU 与命中后刷新 lastAccess。 */
let metaByKey = new Map<string, MediaMeta>()
/** 有效容量上限（min(16GB, 浏览器配额 * 0.9)）。 */
let capBytes = CAP_BYTES
/** 正在缓存中的 key，避免并发重复下载/写入。 */
const inflight = new Set<string>()

/** 启动时申请持久化存储、读取配额并重建元数据索引（顺带清扫过期的封面）。 */
async function loadState(): Promise<void> {
  const quota = await requestPersistentQuota()
  capBytes = effectiveCap(quota)
  const metas = await getAllMeta()
  // 封面缓存 7 天过期：启动期先清算，避免过期项长期占用 16GB 预算
  const stale = expiredKeys(metas)
  if (stale.length) {
    await deleteCached(stale)
    const staleSet = new Set(stale)
    metaByKey = new Map(
      metas.filter((m) => !staleSet.has(m.key)).map((m) => [m.key, m]),
    )
  } else {
    metaByKey = new Map(metas.map((m) => [m.key, m]))
  }
}

/**
 * 从 `/stream/:source/:id?level=` 解析出源 / 曲目 id / 档位 / 缓存 key；
 * 非音频代理路径返回 null。2 段式 `/stream/:id`（旧格式）视为缺省源。
 */
function keyFromStreamUrl(
  url: URL,
): { source: MusicSource; id: string; level: string; key: string } | null {
  if (!url.pathname.startsWith(STREAM_PREFIX)) return null
  const rest = url.pathname.slice(STREAM_PREFIX.length)
  if (!rest) return null

  const slash = rest.indexOf('/')
  let source: MusicSource = DEFAULT_SOURCE
  let id = decodeURIComponent(rest)
  if (slash !== -1) {
    const head = decodeURIComponent(rest.slice(0, slash))
    if (isMusicSource(head)) {
      source = head
      id = decodeURIComponent(rest.slice(slash + 1))
    }
  }
  if (!id) return null
  const level = url.searchParams.get('level') ?? DEFAULT_LEVEL
  return { source, id, level, key: audioKey(source, id, level) }
}

/** 未命中时把整文件写入缓存并做 LRU 淘汰（音频与封面共用同一预算）。 */
async function storeResponse(
  base: Omit<MediaMeta, 'size' | 'lastAccess'>,
  response: Response,
): Promise<void> {
  const key = base.key
  if (inflight.has(key)) return
  inflight.add(key)
  try {
    const blob = await response.blob()
    if (blob.size === 0) return

    const evicted = pickEvictions([...metaByKey.values()], capBytes, blob.size)
    if (evicted.length) {
      await deleteCached(evicted)
      for (const k of evicted) metaByKey.delete(k)
    }

    const now = Date.now()
    const meta: MediaMeta = {
      ...base,
      size: blob.size,
      lastAccess: now,
      cachedAt: now,
    }
    await putCached(meta, blob)
    metaByKey.set(key, meta)
  } catch (err) {
    // 单飞预载被新预载 abort、或播放侧换曲取消下载均属预期：不刷警告
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn('[sw] 写入媒体缓存失败', err)
    }
  } finally {
    inflight.delete(key)
  }
}

/** 命中缓存即返回其切片，并刷新 LRU 时间戳；已过期（封面超 7 天）则清除并按未命中处理。 */
async function serveCached(
  key: string,
  rangeHeader: string | null,
): Promise<Response | null> {
  const cached = await getCached(key)
  if (!cached) return null
  if (isExpired(cached.meta)) {
    // 封面过期：清掉后回源重取（音频 kind !== 'image'，永不走到这里）
    await deleteCached([key])
    metaByKey.delete(key)
    return null
  }
  void touchCached(key)
  const meta = metaByKey.get(key)
  if (meta) meta.lastAccess = Date.now()
  return responseFromBlob(cached.meta, cached.blob, rangeHeader)
}

/** 通知受控页面：某曲目因 VIP / 版权受限需要登录（后端以 403 表达），并带上曲目所属源。 */
async function notifyNeedLogin(source: MusicSource): Promise<void> {
  const clients = await sw.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  for (const client of clients)
    client.postMessage({ type: 'STREAM_NEED_LOGIN', source })
}

/**
 * 带「响应头超时」的上游整段音频 GET：连接建立阶段超时即 abort（弱网下上游长时间不回头会
 * 让请求悬死）。失败 / 超时 / 被取消返回 `null`。`signal` 供预载单飞取消（见 {@link prefetchAudio}）。
 */
async function fetchAudioUpstream(
  url: string,
  signal?: AbortSignal,
): Promise<Response | null> {
  if (signal?.aborted) return null
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  )
  try {
    return await fetch(url, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 校验上游是否为「整段、可缓存音频」，是则返回其 content-type，否则 `null`。
 * 覆盖「非 2xx / 非 `audio/*`」与「非整文件」（seek 切片 206、502 等）两种不可缓存情形。
 */
function cacheableAudioMime(upstream: Response): string | null {
  const ct = upstream.headers.get('content-type') ?? ''
  if (!upstream.ok || !ct.startsWith('audio/')) return null
  if (
    !isWholeFileResponse(upstream.status, upstream.headers.get('content-range'))
  ) {
    return null
  }
  return ct
}

/** `/stream/*`：音频代理（Range 分段、整文件缓存）。 */
async function handleStream(
  event: FetchEventLike,
  request: Request,
  url: URL,
  source: MusicSource,
  id: string,
  level: string,
  key: string,
): Promise<Response> {
  const cached = await serveCached(key, request.headers.get('range'))
  if (cached) return cached

  // 未命中：取整文件（不转发 Range），失败则交由浏览器报错（响应头阶段带超时）
  const upstream = await fetchAudioUpstream(url.href)
  if (!upstream) return Response.error()

  // VIP 未登录 / 版权受限：后端以 403 表达——通知页面给出登录引导，响应原样放行（不缓存）
  if (upstream.status === 403) {
    void notifyNeedLogin(source)
    return upstream
  }

  // 仅缓存完整音频响应（200，或部分 CDN 对无条件请求返回的全量 206）；切片 206 与 502 等直接放行
  const mime = cacheableAudioMime(upstream)
  if (mime) {
    event.waitUntil(
      storeResponse(
        { key, kind: 'audio', source, trackId: id, level, mime },
        upstream.clone(),
      ),
    )
  }
  return upstream
}

/** 单飞：仅允许一条预载在途；新预载 abort 旧的，避免快速切歌时残留整段下载。 */
let prefetchAbort: AbortController | null = null

/**
 * 预载单曲音频：SW **主动**整段下载并写入媒体缓存（页面不接字节，落法 B，见 ADR-037）。
 *
 * - 命中缓存或已有同 key 在途 → no-op；
 * - 403（VIP / 版权）/ 非音频 / 非整段 → 丢弃响应体、**静默跳过**；
 * - **绝不**调用 `notifyNeedLogin`——预载的是「还没打算播」的曲目，弹登录框会打扰用户。
 */
async function prefetchAudio(
  source: MusicSource,
  id: string,
  level: AudioLevel,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  if (metaByKey.has(key) || inflight.has(key)) return
  const href = new URL(streamUrl(source, id, { level }), sw.location.origin)
    .href
  const upstream = await fetchAudioUpstream(href, signal)
  if (!upstream) return
  const mime = cacheableAudioMime(upstream)
  if (!mime) {
    // 403 / 非整段音频：丢弃响应体，静默跳过（不通知登录）
    void upstream.body?.cancel().catch(() => {})
    return
  }
  await storeResponse(
    { key, kind: 'audio', source, trackId: id, level, mime },
    upstream,
  )
}

/** 封面图片：命中即返；未命中以 CORS 拉取可读字节写入同一 IDB 池，失败则原样放行。 */
async function handleImage(
  event: FetchEventLike,
  request: Request,
  url: URL,
  key: string,
): Promise<Response> {
  const cached = await serveCached(key, null)
  if (cached) return cached

  // 原请求是 no-cors（`<img>`），其响应不可读；改以 CORS 重新拉取才能拿到字节写 IDB。
  // `referrerPolicy: 'no-referrer'`：部分图床（如 B 站 hdslb）对异域 Referer 直接 403，故不带。
  let upstream: Response
  try {
    upstream = await fetch(
      new Request(url.href, {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    )
  } catch {
    return fetch(request)
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  if (!upstream.ok || !contentType.startsWith('image/')) {
    // 非图片/失败：退回原始请求（不缓存），保证图片仍能显示
    try {
      return await fetch(request)
    } catch {
      return upstream
    }
  }

  event.waitUntil(
    storeResponse({ key, kind: 'image', mime: contentType }, upstream.clone()),
  )
  return upstream
}

sw.addEventListener('install', (event) => {
  event.waitUntil(sw.skipWaiting())
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await sw.clients.claim()
      await loadState()
    })(),
  )
})

// 页面 → SW 的消息：清空内存元数据索引 / 预载音频。
sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null
  if (!data) return
  // 设置弹窗「清理缓存」后，主线程广播该消息以清空 SW 内存中的元数据索引。
  if (data.type === 'MEDIA_CACHE_CLEARED') {
    metaByKey.clear()
    return
  }
  // 预载：SW 主动整段下载音频写缓存（页面不接字节）。单飞——新预载 abort 旧的。
  if (data.type === PREFETCH_AUDIO) {
    const req = parsePrefetchAudio(data)
    if (!req) return
    prefetchAbort?.abort()
    prefetchAbort = new AbortController()
    event.waitUntil(
      prefetchAudio(
        req.source,
        req.id,
        req.level,
        req.key,
        prefetchAbort.signal,
      ),
    )
  }
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) {
    // 跨域的封面图片同样接管（见 handleImage）
    if (request.destination === 'image') {
      event.respondWith(handleImage(event, request, url, imageKey(url)))
    }
    return
  }

  const parsed = keyFromStreamUrl(url)
  if (parsed) {
    // seek 型 Range（起点 > 0 / 后缀）不接管：由浏览器直接请求同源接口。
    // 若在 SW 内去掉 Range 取整文件应答，seek 将无法完成（seeking 停在
    // waiting/stalled）；播放侧停滞看门狗只能以重载兜底，且每次重载又触发一次整文件请求
    if (!isWholeFileRange(request.headers.get('range'))) return
    event.respondWith(
      handleStream(
        event,
        request,
        url,
        parsed.source,
        parsed.id,
        parsed.level,
        parsed.key,
      ),
    )
    return
  }

  if (request.destination === 'image') {
    event.respondWith(handleImage(event, request, url, imageKey(url)))
  }
})

// 应用外壳与静态图标 precache —— 仅生产环境（dev 下 self.__WB_MANIFEST 不存在）。
if (import.meta.env.PROD) {
  precacheAndRoute(self.__WB_MANIFEST ?? [])
  cleanupOutdatedCaches()
  registerShellRoutes()
}
