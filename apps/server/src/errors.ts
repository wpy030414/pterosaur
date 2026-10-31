import { HTTPException } from 'hono/http-exception'
import type { ErrorHandler } from 'hono'
import { UpstreamError } from './sources/http.js'
import { fail } from './http.js'

/** 带明确状态码与**面向用户**文案的业务错误。 */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 501 | 502,
    message: string,
    readonly needLogin = false,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 面向客户端的文案：保留业务错误与网络类错误的可读原因，
 * **丢弃上游返回的原文**（可能含上游 URL、内部错误码、风控细节）。
 */
function safeReason(err: unknown): string | undefined {
  if (err instanceof ApiError) return err.message
  if (err instanceof UpstreamError) {
    // 网络 / 超时类（code 0）的信息是本机生成的（如 'fetch failed'），可用；
    // 上游状态码 / 业务码只报类别，不报细节
    return err.code === 0 ? err.message : undefined
  }
  return undefined
}

/**
 * 全局错误处理：任何未捕获异常都被映射为统一的 `ApiResult` 失败响应，
 * 避免 Hono 默认的纯文本 500，也避免把内部堆栈 / 上游原文透给前端。
 */
export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ApiError)
    return c.json(fail(err.message, err.needLogin), err.status)
  if (err instanceof HTTPException)
    return c.json(fail(err.message, false), err.status)
  const reason = safeReason(err)
  return c.json(
    fail(reason ? `上游请求失败：${reason}` : '服务内部错误，请稍后重试'),
    502,
  )
}

/**
 * 在需**自定义前缀**的场景（如「搜索失败：」）把异常包成 `ApiError`。
 * 前缀是给人看的；有可读原因时附上，否则只留前缀（不泄漏上游细节）。
 */
export function failure(
  status: 400 | 401 | 403 | 404 | 409 | 501 | 502,
  label: string,
  err: unknown,
): ApiError {
  const reason = safeReason(err)
  return new ApiError(status, reason ? `${label}：${reason}` : label)
}
