import type { Context } from 'hono'
import type { MusicSource } from '@pterosaur/shared/types'
import { adapterOf } from './index.js'
import type { SourceAdapter } from './types.js'
import {
  cacheKey,
  cached,
  credentialOf,
  ctxAdapter,
  fail,
  ok,
  sourceQuery,
} from '../http.js'

/** 已解析的源上下文。`id` 仅 URL 段版（`/:source/:id`）有。 */
export interface SourceContext {
  source: MusicSource
  adapter: SourceAdapter
  /** URL 段里的实体 id（仅 `/:source/:id` 版有）。 */
  id: string
}

interface BaseOptions {
  /** 无该能力时回 501 的提示文案，如「该音源暂不支持排行榜」。 */
  unsupported: string
  /** 失败响应文案前缀，如「获取推荐失败」。 */
  errorLabel: string
  /**
   * 归一化后的参数：**同时**作为缓存键的参数与 `loader` 的实参来源。
   * 在这里做截断 / 缺省，保证「键 == 实参」，无需再手工对齐两处。
   */
  params: (c: Context) => readonly (string | number | boolean | undefined)[]
}

function upstreamFailure(c: Context, label: string, e: unknown): Response {
  return c.json(fail(`${label}：${(e as Error).message}`), 502)
}

/**
 * 定义一条**查询参数版**的缓存源路由（`?source=` 指定源，缺省缺省源）。
 *
 * 统一收口四件事，路由体只剩「调适配器」：
 * 1. 源解析与 404；
 * 2. 可选能力探测——能力缺失回 501，不调适配器；
 * 3. 缓存键由 {@link cacheKey} 统一生成（**自动带凭证指纹**，杜绝手写键漏项，见 ADR-042）；
 * 4. 上游异常统一回 502。
 *
 * 与缓存无关的路由（登录 / 云同步 / 直刻 / 取流）**不走**此工厂
 * （取流另有 URL 缓存与候选轮换，本身就不是纯数据缓存）。
 */
export function defineQueryRoute<T extends object>(
  endpoint: string,
  options: BaseOptions,
  hasCapability: (adapter: SourceAdapter) => boolean,
  loader: (
    ctx: Omit<SourceContext, 'id'> & { params: readonly unknown[] },
    cred: string | undefined,
  ) => Promise<T>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const source = sourceQuery(c)
    const adapter = adapterOf(source)
    if (!adapter) return c.json(fail('未知音源'), 404)
    if (!hasCapability(adapter)) return c.json(fail(options.unsupported), 501)
    const cred = credentialOf(c, adapter)
    const params = options.params(c)
    try {
      const value = await cached(cacheKey(source, endpoint, params, cred), () =>
        loader({ source, adapter, params }, cred),
      )
      return c.json(ok(value))
    } catch (e) {
      return upstreamFailure(c, options.errorLabel, e)
    }
  }
}

/**
 * 定义一条**URL 段版**的缓存源路由（`/:source/:id`，2 段式别名缺省源）。
 * 缓存键 = `源|端点|id|params…|凭证指纹`。
 */
export function defineSegRoute<T extends object>(
  endpoint: string,
  options: Omit<BaseOptions, 'params'> & {
    params?: (c: Context) => readonly (string | undefined)[]
  },
  hasCapability: (adapter: SourceAdapter) => boolean,
  loader: (
    ctx: SourceContext & { params: readonly (string | undefined)[] },
    cred: string | undefined,
  ) => Promise<T>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const ctx = ctxAdapter(c)
    if (!ctx) return c.json(fail('未知音源'), 404)
    if (!hasCapability(ctx.adapter))
      return c.json(fail(options.unsupported), 501)
    const id = c.req.param('id') ?? ''
    const cred = credentialOf(c, ctx.adapter)
    const params = options.params?.(c) ?? []
    try {
      const value = await cached(
        cacheKey(ctx.source, endpoint, [id, ...params], cred),
        () => loader({ ...ctx, id, params }, cred),
      )
      return c.json(ok(value))
    } catch (e) {
      return upstreamFailure(c, options.errorLabel, e)
    }
  }
}
