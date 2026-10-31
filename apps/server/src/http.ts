import type { Context } from 'hono'
import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { isLoopbackHost } from '@pterosaur/shared/rip'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  isMusicSource,
  DEFAULT_SOURCE,
  ALL_SOURCES,
  type ApiResult,
  type AudioQuality,
  type MusicSource,
} from '@pterosaur/shared/types'
import { adapterOf } from './sources/index.js'
import type { SourceAdapter } from './sources/types.js'

/** 统一成功响应。 */
export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

/** 统一失败响应。 */
export function fail(error: string, needLogin = false): ApiResult<never> {
  return { ok: false, error, needLogin: needLogin || undefined }
}

/* ============================ 缓存 ============================ */

/**
 * 后端**唯一**的 LRU 缓存工厂：容量 / TTL 在此集中登记，新增缓存不许再随手
 * `new LRUCache(...)`（散落的 TTL 与键格式曾出现「同类数据两套口径」）。
 * TTL 单位毫秒；`ttl: 0` 表示不按时间过期、只受容量淘汰。
 */
export function cacheOf<V extends {}>(max: number, ttlMs: number) {
  return new LRUCache<string, V>({
    max,
    ttl: ttlMs > 0 ? ttlMs : undefined,
  })
}

/** 各类缓存的统一口径（HTTP 状态码式命名：分钟数放在常量里，避免魔法数散落）。 */
const MIN = 60_000
export const CACHE_TTL = {
  /** 音频地址 / 音质：上游直链时效短，15 分钟内基本可用。 */
  audioUrl: 15 * MIN,
  /** 结构化数据（搜索 / 发现 / 详情 / 歌词），见 ADR-042。 */
  data: 120 * MIN,
  /** 翻录能力探测：5 秒，兼顾「换盘后重新检测」。 */
  ripCapabilities: 5_000,
} as const

/** 音频地址缓存：`源|id|档位|凭证指纹` -> **有序候选 https 地址**（首个优先）。 */
export const urlCache = cacheOf<string[]>(2000, CACHE_TTL.audioUrl)

/** 音质查询缓存：`源|id|档位|凭证指纹` -> 实际音质（只缓存成功结果），与地址缓存同口径。 */
export const qualityCache = cacheOf<AudioQuality>(2000, CACHE_TTL.audioUrl)

/**
 * 结构化数据缓存：搜索 / 发现 / 详情 / 分P / 歌词等**已归一化的 JSON 结果**，
 * 键为 `源|端点|归一化参数|凭证指纹`（见 ADR-042）。导出实例供单测观察（清空 / TTL 断言）。
 */
export const DATA_CACHE_TTL_MS = CACHE_TTL.data
export const dataCache = cacheOf<object>(1000, DATA_CACHE_TTL_MS)

/**
 * 包装一次上游结构化数据读取：命中缓存直接返回；未命中执行 loader、**成功才入缓存**——
 * 抛错（上游故障 / 风控，路由回 502）不缓存，下次请求立即重试。适配器把失败降级为
 * 空结果的（B 站歌词 / 分P 返空数组）空结果也会被缓存：防反复打挂上游，TTL 到期自愈。
 *
 * 键必须含**凭证指纹**：匿名访客与登录用户、不同账号间同一请求可能得到不同结果
 * （B 站字幕匿名恒空、网易云 VIP 标记），不隔离会串数据；匿名访客全体回落到服务端
 * 缺省凭证（`credentialOf`），恰好共享同一条目。
 *
 * 键用 {@link cacheKey} 生成（`源|端点|参数…|凭证指纹`）；适配器**源内**的缓存
 * （如 B 站 `view`）也用它，保证全后端只有一种键格式。
 */
export async function cached<T extends object>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = dataCache.get(key)
  if (hit !== undefined) return hit as T
  const value = await loader()
  dataCache.set(key, value)
  return value
}

/**
 * **唯一的**缓存键构造器：`源|端点|参数…|凭证指纹`。
 * 参数按传入顺序一律 `String()` 化——调用方须先归一化（截断 / 缺省值），
 * 再把**归一化后的值**传进来，保证「键 == 实参」。
 */
export function cacheKey(
  source: MusicSource,
  endpoint: string,
  params: readonly (string | number | boolean | undefined)[],
  credential?: string,
): string {
  return [
    source,
    endpoint,
    ...params.map((p) => (p === undefined ? '' : String(p))),
    credentialKey(credential),
  ].join('|')
}

/* ============================ 源解析 ============================ */

/**
 * 从 `?source=` 查询参数解析音源；缺省为缺省源（网易云）。
 */
export function sourceQuery(c: Context): MusicSource {
  const s = c.req.query('source')
  return isMusicSource(s) ? s : DEFAULT_SOURCE
}

/**
 * 解析路由的源：`:source` 段**缺省为缺省源**（兼容 2 段式别名路由，如 `/api/album/:id`）；
 * 非法（如本地歌单 id `pl-…`）或未注册返回 null（调用方回 404）。
 */
export function ctxAdapter(
  c: Context,
): { source: MusicSource; adapter: SourceAdapter } | null {
  const raw = c.req.param('source')
  const source =
    raw === undefined ? DEFAULT_SOURCE : isMusicSource(raw) ? raw : null
  if (!source) return null
  const adapter = adapterOf(source)
  return adapter ? { source, adapter } : null
}

/**
 * 归一化分页字段：`limit` 收口到 `[1, max]`（缺省 `fallback`），`page` 从 1 起。
 * 非法 / 缺失值一律走缺省，**不**把 NaN 透传给上游；返回值即缓存键的实参。
 */
export function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  return Math.min(Math.max(Number(raw) || fallback, 1), max)
}

export function parsePage(raw: string | undefined): number {
  return Math.max(1, Math.floor(Number(raw) || 1))
}

/* ============================ 凭证 / 身份 ============================ */

/** 从请求头取出**指定源**的会话 cookie 字符串（仅访客本人会话，用于身份判断）。 */
export function cookieOf(
  c: Context,
  adapter: SourceAdapter,
): string | undefined {
  const raw = c.req.header('cookie')
  if (!raw) return undefined
  const names = adapter.sessionCookieNames
  const parts = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((kv) => names.includes(kv.slice(0, kv.indexOf('='))))
  return parts.length ? parts.join('; ') : undefined
}

/**
 * 服务端缺省凭证：由 `pnpm log-in --source=<源>` 写入仓库根 `.env`
 * （`NETEASE_COOKIE` / `BILIBILI_COOKIE`）。供**未登录访客**解析会员资源，不代表访客身份。
 */
const DEFAULT_CREDENTIAL_ENV: Record<MusicSource, string> = {
  netease: 'NETEASE_COOKIE',
  bilibili: 'BILIBILI_COOKIE',
}
export function defaultCredential(source: MusicSource): string | undefined {
  const v = process.env[DEFAULT_CREDENTIAL_ENV[source]]?.trim()
  return v || undefined
}

/**
 * **内容接口**所用凭证：优先访客本人会话，回退到服务端缺省凭证。
 * 只用于搜索 / 播放 / 歌词等内容解析，绝不用于身份判断。
 */
export function credentialOf(
  c: Context,
  adapter: SourceAdapter,
): string | undefined {
  return cookieOf(c, adapter) ?? defaultCredential(adapter.id)
}

/** 缓存键里的凭证指纹：区分匿名 / 不同账号，避免串用解析出的地址或数据。 */
export function credentialKey(cookie?: string): string {
  if (!cookie) return 'anon'
  return createHash('sha1').update(cookie).digest('hex').slice(0, 12)
}

/**
 * 解析**访客本人**的活动账号身份 `{ source, id }`（最多一个源已登录）；未登录返回 `null`。
 * 身份接口专用——**绝不回退到缺省凭证**，否则会把匿名访客当成运营者账号。
 */
export async function requireIdentity(
  c: Context,
): Promise<{ source: MusicSource; id: string } | null> {
  // 遍历**全部源**（含磁带渠道）：登录 B 站同样是一个可云同步的账号身份
  for (const source of ALL_SOURCES) {
    const adapter = adapterOf(source)
    if (!adapter) continue
    const st = await adapter.loginStatus(cookieOf(c, adapter))
    if (st.logged && st.userId) return { source, id: st.userId }
  }
  return null
}

/** 云同步的文件键：`<source>-<账号id>`（单活动账号，故与源绑定）。 */
export function syncKey(identity: { source: MusicSource; id: string }): string {
  return `${identity.source}-${identity.id}`
}

/* ============================ 门控 / 会话 ============================ */

/**
 * 直刻路由的**回环硬门控**（见 ADR-048）：仅允许后端所在设备本机访问
 * （`localhost` / `127.x.y.z` / `::1`）。连接信息探测失败一律拒绝（fail-closed）。
 *
 * 已知边界：同机 nginx 反代下对端恒为回环、本门控退化为纵深防御——前端
 * `location.hostname` 门控为主，故**请勿将本服务暴露至公网**。
 */
export function requireLoopback(c: Context): boolean {
  try {
    return isLoopbackHost(getConnInfo(c).remote.address ?? '')
  } catch {
    return false
  }
}

/**
 * 只把登录响应中会话必需的 Set-Cookie 下发给浏览器（同源；生产 https 下安全存储）。
 * 上游会附带数十条无关 cookie，且部分带 `Domain=…` / `Secure` / `SameSite`——须剥离，
 * 否则浏览器会把这些 cookie 存到上游域而非本域，导致会话建立失败。
 */
export function forwardSessionCookies(
  c: Context,
  adapter: SourceAdapter,
  cookies?: string[],
) {
  if (!cookies?.length) return
  const names = adapter.sessionCookieNames
  for (const raw of cookies) {
    const name = raw.slice(0, raw.indexOf('='))
    if (!names.includes(name)) continue
    const cleaned = raw
      .replace(/;\s*Domain=[^;]*/i, '')
      .replace(/;\s*Secure/i, '')
      .replace(/;\s*SameSite=\w+/i, '')
    c.header('Set-Cookie', `${cleaned}; Path=/; SameSite=Lax`, { append: true })
  }
}

/** 下发过期 Set-Cookie，让浏览器删除指定名称的会话 cookie（退出 / 清失效残留 / 单活动账号互斥）。 */
export function clearCookies(c: Context, names: readonly string[]) {
  for (const name of names) {
    c.header('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax`, {
      append: true,
    })
  }
}
