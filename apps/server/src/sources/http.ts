import { createHash } from 'node:crypto'
import type { AudioQuality } from '@pterosaur/shared/types'

/** 浏览器 UA（部分上游对非浏览器 UA 较敏感）。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/* ============================ 通用工具 ============================ */

/** 把地址统一改写为 https（上游常回 `http://`，https 站点会拦截混合内容）。 */
export function toHttps(url: string): string {
  return url.replace(/^http:\/\//, 'https://')
}

/**
 * 凭证指纹（`sha1` 前 12 位）：缓存键里区分匿名 / 不同账号，避免串用解析结果。
 * 与 `http.credentialKey` **同一算法**——此处独立实现是为让适配器不依赖路由层；
 * 两者一旦分叉，同一账号在数据缓存与源内缓存会被视为两把不同的钥匙。
 */
export function credentialFingerprint(cred?: string): string {
  if (!cred) return 'anon'
  return createHash('sha1').update(cred).digest('hex').slice(0, 12)
}

/** 从 Set-Cookie 数组中挑出指定名称的 cookie，收敛为可直接透传的 `Cookie` 头值。 */
export function sessionCookieHeader(
  cookies: readonly string[] | undefined,
  names: readonly string[],
): string | undefined {
  if (!cookies?.length) return undefined
  const parts: string[] = []
  for (const c of cookies) {
    const kv = c.split(';')[0]?.trim()
    if (!kv) continue
    const name = kv.slice(0, kv.indexOf('='))
    if (names.includes(name)) parts.push(kv)
  }
  return parts.length ? parts.join('; ') : undefined
}

/* ============================ 上游请求 ============================ */

/** 上游失败。`code` 复用 HTTP 状态；网络错误 / 超时记为 0（瞬时）。 */
export class UpstreamError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/** 瞬时故障：网络错误、超时、5xx、429——值得重试。 */
export function isTransientError(err: UpstreamError): boolean {
  return err.code === 0 || err.code >= 500 || err.code === 429
}

/** 上游声明缓存寿命时预留的提前量：避免客户端卡在「刚好过期」的边缘回源。 */
export const STREAM_EXPIRY_MARGIN_MS = 60_000

/**
 * 从上游响应头推断「该地址可复用到何时」（毫秒时间戳）；上游未声明寿命时返回 `null`。
 *
 * 只认 `Cache-Control` 的 `max-age` 与 `Expires`，取两者较早者再减 {@link STREAM_EXPIRY_MARGIN_MS}。
 * `no-cache` / `private` 等指令不改变「地址本身仍有效」的事实，忽略；`no-store` 表示上游
 * 不希望被缓存——返回 `now`（立刻到期），把它当成「无可复用寿命」。
 *
 * 调用方再与自身地址缓存的 TTL 取较早者，决定实际下发给浏览器的 `max-age`。
 */
export function upstreamExpiresAt(res: Response, now: number): number | null {
  const cc = res.headers.get('cache-control')?.toLowerCase() ?? ''
  const directives = cc.split(',').map((s) => s.trim())
  if (directives.some((d) => d === 'no-store' || d.startsWith('no-store='))) {
    return now
  }

  let expiresAt: number | null = null
  const maxAge = directives
    .map((d) => /^max-age=(\d+)$/.exec(d))
    .find((m) => m !== null)
  if (maxAge) expiresAt = now + Number(maxAge[1]) * 1000

  const expiresHeader = res.headers.get('expires')
  if (expiresHeader) {
    const parsed = Date.parse(expiresHeader)
    if (Number.isFinite(parsed)) {
      expiresAt = expiresAt === null ? parsed : Math.min(expiresAt, parsed)
    }
  }
  if (expiresAt === null) return null
  return expiresAt - STREAM_EXPIRY_MARGIN_MS
}

export interface UpstreamOptions {
  /** 默认 `BROWSER_UA`。 */
  userAgent?: string
  /** 必需的上游来源页（部分 CDN 不带即 403）。 */
  referer?: string
  cookie?: string
  headers?: Record<string, string>
  /** 单次请求墙钟超时，默认 15s。 */
  timeoutMs?: number
  /** 总尝试次数（含首次），默认 1 即不重试。 */
  attempts?: number
  /** 重试间隔，默认 333ms。 */
  retryDelayMs?: number
  /**
   * 被重试的错误类别，默认 {@link isTransientError}。
   *
   * 这是本层存在的关键理由：此前 B 站对所有业务码无差别重试 5 次——风控（`v_voucher`）
   * 也会被反复补刀。业务码 / 4xx 应交给调用方降级，而不是重试。
   */
  retryOn?: (err: UpstreamError) => boolean
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** `fetch` 薄封装：统一 UA / Referer / Cookie / 超时，按类别重试，失败抛 {@link UpstreamError}。 */
export async function upstreamFetch(
  url: string,
  init: {
    method?: string
    body?: string
    headers?: Record<string, string>
  } = {},
  options: UpstreamOptions = {},
): Promise<Response> {
  const {
    userAgent = BROWSER_UA,
    referer,
    cookie,
    headers,
    timeoutMs = 15_000,
    attempts = 1,
    retryDelayMs = 333,
    retryOn = isTransientError,
  } = options
  let lastErr = new UpstreamError(0, '上游请求失败')
  // attempts = 总尝试次数（首次 + attempts-1 次重试）
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs)
    try {
      const res = await fetch(url, {
        method: init.method,
        body: init.body,
        headers: {
          'User-Agent': userAgent,
          ...(referer ? { Referer: referer } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...init.headers,
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new UpstreamError(res.status, `HTTP ${res.status}`)
      return res
    } catch (e) {
      lastErr =
        e instanceof UpstreamError
          ? e
          : new UpstreamError(0, e instanceof Error ? e.message : String(e))
      if (!retryOn(lastErr)) break
    }
  }
  throw lastErr
}

/** 同上，直接解析 JSON。 */
export async function upstreamJson<T>(
  url: string,
  options: UpstreamOptions = {},
): Promise<T> {
  const res = await upstreamFetch(url, {}, options)
  return (await res.json()) as T
}

/** 上游业务码失败（如 B 站 `code !== 0`）。 */
export function businessError(code: number, label: string): UpstreamError {
  return new UpstreamError(code, `${label} code ${code}`)
}

/* ============================ 音质 ============================ */

/** 采样率探测单次读取的字节数（音频 init segment 实测 < 4KB，32KB 裕量充足）。 */
export const PROBE_BYTES = 32 * 1024

/**
 * 逐个候选 URL 取**文件头前缀**并解析；任一候选成功即返回。**不重试单个候选**——
 * 探测只用于展示音质，失败应静默缺席，不能外溢成播放失败或拖慢接口。
 */
export async function probeFirstCandidate<T>(
  urls: readonly string[],
  headers: Record<string, string>,
  parse: (head: Uint8Array) => T | undefined,
  timeoutMs = 5_000,
): Promise<T | undefined> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=0-${PROBE_BYTES - 1}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue
      const hit = parse(new Uint8Array(await res.arrayBuffer()))
      if (hit !== undefined) return hit
    } catch {
      /* 试下一个候选 */
    }
  }
  return undefined
}

/** 由上游回报的类型字段推导编解码显示名；缺失时回退直链后缀。 */
export function codecName(raw: unknown, url: string): string | undefined {
  // 上游字段可能是任意 JSON 值：只接受标量
  const s = (
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (s) return s.toUpperCase()
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
  return ext && /^[a-z0-9]{2,4}$/.test(ext) ? ext.toUpperCase() : undefined
}

/** 组装 `AudioQuality`：只保留合法正值，缺失字段不臆造。 */
export function makeQuality(
  codec: string | undefined,
  br: unknown,
  sr: unknown,
): AudioQuality {
  return {
    codec,
    br: typeof br === 'number' && br > 0 ? br : undefined,
    sr: typeof sr === 'number' && sr > 0 ? sr : undefined,
  }
}

/* ============================ fMP4 init segment ============================ */

/** MP4 box 树中需继续下钻的容器 box（init segment 的采样率深藏在 `moov/…/stbl/stsd` 里）。 */
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
/** AudioSampleEntry 标准布局的音频格式（采样率字段偏移一致）；FLAC 轨走扩展布局，不在此路径。 */
const MP4_AUDIO_FORMATS = new Set(['mp4a', 'ac-3', 'ec-3'])

/**
 * 从 fMP4 init segment（文件头部若干 KB）解析音频采样率（Hz）；解析不出返回 `undefined`。
 *
 * B 站 `playurl` **不回报采样率**（`dash.audio[]` 只有 id/bandwidth/mime/codecs），而共享
 * `AudioQuality.sr` 有展示位——唯一诚实的取法是读文件头：音频 DASH 直链是完整 fMP4，
 * `ftyp + moov` 在最前面，采样率就在 `stsd` 首个 sample entry（AudioSampleEntry，ISO 14496-12：
 * box 头 8 字节 + SampleEntry 8 字节 + 保留 8 字节后，第 24 字节偏移处的 16.16 定点采样率）。
 * 纯函数（递归走 box 树），导出供单测。
 */
export function parseSampleRate(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const typeAt = (p: number): string =>
    String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3])

  const find = (start: number, end: number): number | undefined => {
    let pos = start
    while (pos + 8 <= end) {
      const size = view.getUint32(pos)
      const type = typeAt(pos + 4)
      const boxEnd = size === 0 ? end : pos + size // size=0：box 延伸到缓冲区末尾
      if (boxEnd > end || boxEnd < pos + 8) return undefined // 脏数据：整段放弃
      if (type === 'stsd') {
        // 头 8 + version/flags 4 + entry_count 4 → 首个 sample entry
        const entry = pos + 16
        if (entry + 36 > boxEnd) return undefined
        if (!MP4_AUDIO_FORMATS.has(typeAt(entry + 4))) return undefined
        const sr = view.getUint32(entry + 8 + 24) >>> 16
        return sr > 0 ? sr : undefined
      }
      if (MP4_CONTAINERS.has(type)) {
        const hit = find(pos + 8, boxEnd)
        if (hit !== undefined) return hit
      }
      pos = boxEnd
    }
    return undefined
  }

  return find(0, bytes.byteLength)
}
