import { useCallback, useEffect, useRef, useState } from 'react'
import { registerCacheCleaner } from '../lib/cacheRegistry.js'

interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

interface CacheEntry {
  data: unknown
  /** 写入时刻（而非「最近访问」），用于 TTL 判定。 */
  at: number
}

/**
 * 内存取数缓存口径：
 * - **有上限**（LRU 淘汰最久未用的条目），避免浏览越多实体内存越大；
 * - **有 TTL**，到期视为未命中并顺手清理；
 * - 只在成功时写入，失败不缓存（下一次请求自然重试）。
 */
const CACHE_MAX = 60
const CACHE_TTL_MS = 5 * 60_000

/**
 * `Map` 天然保持插入序：写入末尾即「最近使用」，淘汰首个即最久未用。
 * 命中时先删再插，把条目移到末尾。
 */
const asyncCache = new Map<string, CacheEntry>()

function readCache<T>(key: string): T | undefined {
  const hit = asyncCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    asyncCache.delete(key)
    return undefined
  }
  // LRU：移到末尾
  asyncCache.delete(key)
  asyncCache.set(key, hit)
  return hit.data as T
}

function writeCache(key: string, data: unknown): void {
  asyncCache.delete(key)
  asyncCache.set(key, { data, at: Date.now() })
  while (asyncCache.size > CACHE_MAX) {
    const oldest = asyncCache.keys().next().value
    if (oldest === undefined) break
    asyncCache.delete(oldest)
  }
}

/** 清空内存取数缓存（登录 / 退出登录等凭证变化时作废旧结果）。 */
export function clearAsyncCache(): void {
  asyncCache.clear()
}

/** 只作废以某前缀开头的条目（如 `playlist:` 在本地歌单被改动后）。 */
export function invalidateAsyncCache(prefix: string): void {
  // Map 的迭代器在删除当前键后仍能继续，无需先复制键数组
  for (const key of asyncCache.keys()) {
    if (key.startsWith(prefix)) asyncCache.delete(key)
  }
}

/**
 * 通用异步数据钩子。
 *
 * @param fetcher 返回 Promise 的取数函数
 * @param deps 依赖数组，变化时自动重新取数（与 useEffect 一致）
 * @param initial 初始数据
 * @param cacheKey 可选缓存键：命中时**同步**返回（且不计入 loading），成功后写回。
 *   键必须能唯一标识「这份数据」——含凭证相关维度（如源）或干脆不含，二者取其一；
 *   详情类页面用它让「参数切换」直接出内容而非骨架。
 *
 * 缓存本身有容量上限与 TTL（见文件头），并由 {@link invalidateAsyncCache} 按前缀失效。
 * 组件卸载后不会再 setState；并发请求以最后一次为准。
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  initial: T | null = null,
  cacheKey?: string,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: initial,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)
  const aliveRef = useRef(true)
  const reqIdRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    const reqId = ++reqIdRef.current
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))

    fetcher()
      .then((data) => {
        if (cancelled || !aliveRef.current || reqId !== reqIdRef.current) return
        if (cacheKey !== undefined) writeCache(cacheKey, data)
        setState({ data, loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (cancelled || !aliveRef.current || reqId !== reqIdRef.current) return
        setState((s) => ({
          data: s.data,
          loading: false,
          error: (e as Error).message,
        }))
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, cacheKey])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // 命中缓存时同步返回并免去加载态，使参数切换时的转场为「旧内容 → 新内容」而非「旧内容 → 骨架」。
  // `nonce > 0` 表示用户主动 reload：跳过缓存直读网络，否则「重试」在 TTL 内仍会回显旧数据。
  const cached =
    cacheKey !== undefined && nonce === 0 ? readCache<T>(cacheKey) : undefined

  return {
    data: cached !== undefined ? cached : state.data,
    loading: state.loading && cached === undefined,
    error: state.error,
    reload,
  }
}

// 自注册到统一清缓存：新增内存缓存不必再改 clearCaches 的清单
registerCacheCleaner(clearAsyncCache)
