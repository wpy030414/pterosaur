/**
 * 上游音频取流的共用低层逻辑。
 *
 * `streamHandler`（浏览器 Range 代理）与翻录直刻模块（整曲落盘 / 转码前拉取）
 * 都经此取流：候选地址依次轮换、连接建立阶段超时中止、非 2xx/206 丢弃重试——
 * 「同一实现的取流韧性」，避免两处各写一份。
 */

/** 上游请求伪装的 UA：多数 CDN 校验非空 UA，缺失可能被直接拒绝。 */
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 上游 CDN 响应头超时（毫秒）：仅约束连接建立阶段——CDN 挂起时避免请求被拖到
 * undici 默认的 300s body timeout（生产另受 nginx 60s read timeout 限制）。
 * body 阶段不设整体超时：长音频在弱网下慢速下载属正常。
 */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000

export interface AudioFetchResult {
  res: Response
  /** 实际命中的候选地址。 */
  usedUrl: string
}

/**
 * 依次尝试候选地址取流，返回首个成功（2xx / 206）的响应；全部失败返回 null。
 *
 * 每次尝试独立计时（连接建立超时即中止该候选、换下一个）；非 2xx/206 的响应体
 * 主动丢弃后继续——B 站等源的直链含多个 CDN 镜像，单节点故障不应直接判死。
 */
export async function fetchAudioCandidate(
  candidates: string[],
  headers: Record<string, string>,
  timeoutMs: number = UPSTREAM_HEADERS_TIMEOUT_MS,
): Promise<AudioFetchResult | null> {
  for (const candidate of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(candidate, {
        headers,
        redirect: 'follow',
        signal: controller.signal,
      })
      if (res.ok || res.status === 206) {
        return { res, usedUrl: candidate }
      }
      // 非 2xx / 非 206：丢弃该连接的响应体，继续下一个候选
      void res.body?.cancel()
    } catch {
      /* 连接失败 / 超时：继续下一个候选 */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/**
 * 由**解析出的音频直链后缀**推断响应的 `Content-Type`。
 *
 * 上游常谎报类型：网易云对 `.flac`（无损 / Hi-Res）仍回 `audio/mpeg`，B 站 m4s 回
 * `application/octet-stream`。若照抄上游，浏览器下载会落成 `.mp3`（前端 `extFromMime` 依
 * `Content-Type` 推后缀），SW 也会因非 `audio/*` 而跳过缓存。**URL 后缀才是权威格式**，故优先它。
 * 无法判定时返回 `undefined`，调用方回退上游头、再回退 `audio/mpeg`。
 */
export function audioContentTypeFromUrl(url: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    return undefined
  }
  if (pathname.endsWith('.flac')) return 'audio/flac'
  if (pathname.endsWith('.mp3')) return 'audio/mpeg'
  if (
    pathname.endsWith('.m4a') ||
    pathname.endsWith('.mp4') ||
    pathname.endsWith('.m4s')
  )
    return 'audio/mp4'
  if (pathname.endsWith('.wav')) return 'audio/wav'
  if (pathname.endsWith('.ogg') || pathname.endsWith('.oga')) return 'audio/ogg'
  if (pathname.endsWith('.aac')) return 'audio/aac'
  return undefined
}
