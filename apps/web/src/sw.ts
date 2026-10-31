/**
 * 应用 Service Worker —— 只剩两件事（ADR-060）：
 *
 * 1. **离线保存**：接受页面 `PREFETCH_AUDIO` 消息，主动整段下载某曲并写入 IndexedDB。
 *    这就是用户在「离线保存」里看到的那一份；播放不走它——`<audio>` 直连后端，由浏览器
 *    原生 HTTP 缓存负责省流与 seek（SW 合成的媒体响应无法支撑可 seek 的流，见 ADR-050）。
 * 2. **应用外壳**（仅生产）：导航 HTML 走 NetworkFirst、同源 script/style 走
 *    StaleWhileRevalidate，缓存 7 天后过期（见 `lib/shellCache.ts`）；precache 只含静态图标/清单。
 *
 * **不拦截任何请求**：没有 `fetch` 处理器，封面与音频都由浏览器自行缓存。
 */
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import {
  CAP_BYTES,
  type SavedAudio,
  effectiveCap,
  getAllMeta,
  isWholeFileResponse,
  pickEvictions,
  removeSaved,
  requestPersistentQuota,
  saveAudio,
} from './lib/mediaCache.js'
import { registerShellRoutes } from './lib/shellCache.js'
import { parsePrefetchAudio, PREFETCH_AUDIO } from './lib/prefetchProtocol.js'
import {
  streamUrl,
  type AudioLevel,
  type MusicSource,
} from '@pterosaur/shared/types'

// —— 最小化 SW 全局类型声明：避免引入 `webworker` lib 与既有 `DOM` lib 产生重复标识符冲突 ——
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
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
  addEventListener(
    type: 'message',
    listener: (e: MessageEventLike) => void,
  ): void
  readonly location: Location
  readonly clients: {
    claim(): Promise<void>
  }
  skipWaiting(): Promise<void>
}

const sw = globalThis as unknown as ServiceWorkerGlobalScopeLike

/**
 * 下载阶段的响应头超时（毫秒）。仅约束连接建立阶段——网络差时上游可能长时间不返回
 * 响应头而让下载悬死；超时即 abort。body 阶段不设整体超时：长音频在弱网下慢速下载属正常。
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000

/** 内存中的元数据索引（轻量，不含 blob）：跳过已保存的曲目 + LRU 淘汰。 */
let savedByKey = new Map<string, SavedAudio>()
/** 有效容量上限（min(16GB, 浏览器配额 * 0.9)）。 */
let capBytes = CAP_BYTES
/** 正在下载中的 key，避免并发重复下载 / 写入。 */
const inflight = new Set<string>()

/**
 * 启动时申请持久化存储、读取配额并重建元数据索引。
 *
 * v5 起媒体池只装音频；旧库若残留封面条目（`kind === 'image'`）直接删除——那是已废止的
 * 封面缓存（ADR-060），留着只会白占预算。
 */
async function loadState(): Promise<void> {
  const quota = await requestPersistentQuota()
  capBytes = effectiveCap(quota)
  const metas = await getAllMeta()
  const stale = metas.filter((m) => m.kind !== 'audio')
  if (stale.length) await removeSaved(stale.map((m) => m.key))
  savedByKey = new Map(
    metas
      .filter((m): m is typeof m & { kind: 'audio' } => m.kind === 'audio')
      .map((m) => [
        m.key,
        {
          key: m.key,
          source: m.source ?? 'netease',
          trackId: m.trackId ?? m.key,
          level: m.level ?? '',
          mime: m.mime,
          size: m.size,
          lastAccess: m.lastAccess,
        },
      ]),
  )
}

/**
 * 带「响应头超时」的上游整段 GET：连接建立阶段超时即 abort。失败 / 超时 / 被取消返回 `null`。
 * `signal` 供单飞取消（新请求 abort 旧的）。
 */
async function fetchUpstream(
  url: string,
  signal: AbortSignal,
): Promise<Response | null> {
  if (signal.aborted) return null
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort)
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  )
  try {
    // 若浏览器 HTTP 缓存里已有整曲（刚听过），直接拿它落盘，不再回源。
    return await fetch(url, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 校验上游是否为「整段、可保存的音频」，是则返回其 content-type，否则 `null`。
 * 覆盖「非 2xx / 非 `audio/*`」与「非整文件」（切片 206、502 等）两种不可保存情形。
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

/** 单飞：仅允许一条下载在途；新请求 abort 旧的，避免快速切歌时残留整段下载。 */
let prefetchAbort: AbortController | null = null

/**
 * 下载单曲并**离线保存**（页面不接字节）。
 *
 * - 已保存或已有同 key 在途 → no-op；
 * - 403（VIP / 版权）/ 非音频 / 非整段 → 丢弃响应体、**静默跳过**；
 * - 按 LRU 淘汰后再写入，使容量不超出预算。
 */
async function saveTrack(
  source: MusicSource,
  id: string,
  level: AudioLevel,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  if (savedByKey.has(key) || inflight.has(key)) return
  inflight.add(key)
  try {
    const href = new URL(streamUrl(source, id, { level }), sw.location.origin)
      .href
    const upstream = await fetchUpstream(href, signal)
    if (!upstream) return
    const mime = cacheableAudioMime(upstream)
    if (!mime) {
      // 403 / 非整段音频：丢弃响应体，静默跳过
      void upstream.body?.cancel().catch(() => {})
      return
    }
    const blob = await upstream.blob()
    if (blob.size === 0) return

    const evicted = pickEvictions([...savedByKey.values()], capBytes, blob.size)
    if (evicted.length) {
      await removeSaved(evicted)
      for (const k of evicted) savedByKey.delete(k)
    }

    await saveAudio(source, id, level, blob, mime)
    savedByKey.set(key, {
      key,
      source,
      trackId: id,
      level,
      mime,
      size: blob.size,
      lastAccess: Date.now(),
    })
  } catch (err) {
    // 单飞被新请求 abort、或换曲取消下载均属预期：不刷警告
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn('[sw] 写入离线保存失败', err)
    }
  } finally {
    inflight.delete(key)
  }
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

// 页面 → SW 的消息：清空内存索引 / 下载并离线保存。
sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null
  if (!data) return
  // 设置弹窗「清除全部离线」后，主线程广播该消息以清空 SW 内存中的索引。
  if (data.type === 'MEDIA_CACHE_CLEARED') {
    savedByKey.clear()
    return
  }
  // 下载并离线保存（页面不接字节）。单飞——新请求 abort 旧的。
  if (data.type === PREFETCH_AUDIO) {
    const req = parsePrefetchAudio(data)
    if (!req) return
    prefetchAbort?.abort()
    prefetchAbort = new AbortController()
    event.waitUntil(
      saveTrack(req.source, req.id, req.level, req.key, prefetchAbort.signal),
    )
  }
})

// 应用外壳与静态图标 precache —— 仅生产环境（dev 下 self.__WB_MANIFEST 不存在）。
if (import.meta.env.PROD) {
  precacheAndRoute(self.__WB_MANIFEST ?? [])
  cleanupOutdatedCaches()
  registerShellRoutes()
}
