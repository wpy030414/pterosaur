import { canonicalNeteaseImage } from '@pterosaur/shared/image'
import { registerCacheCleaner } from './cacheRegistry.js'

/**
 * 封面「已就绪」登记表。
 *
 * 存在意义：沉浸页封面在 View Transition 的**同步快照**里必须已经可见——若依赖 `onLoad`
 * 之后才 `opacity: 1`，快照拍到的会是 `.cover` 的占位底色（一个灰方块放大，正是"简陋"观感
 * 的来源）。而回调里又不能 `await`（rAF 会死锁，见 nowPlayingTransition.ts），所以改用一张
 * 「已解码 URL」表：`Cover` 首帧即按它决定是否直接显色。
 *
 * 键为规范化 URL（shared/image）：网易云随机轮换 p1–pN 镜像主机，同一封面经不同端点 /
 * 新旧持久化数据会得到不同字符串，规范化后互相命中，避免同图反复预载。
 * URL 被移除无需通知（同源封面 URL 稳定）；表按插入顺序限量淘汰。
 */

const ready = new Set<string>()
const MAX = 512

/** 登记表键：规范化后的地址（非网易云地址原样）。 */
function key(src: string): string {
  return canonicalNeteaseImage(src)
}

export function isCoverReady(src?: string): boolean {
  return !!src && ready.has(key(src))
}

export function markCoverReady(src?: string): void {
  if (!src) return
  ready.add(key(src))
  while (ready.size > MAX) {
    const oldest = ready.values().next().value
    if (oldest === undefined) break
    ready.delete(oldest)
  }
}

/** 进行中的封面加载：同一 URL 的并发等待共享一次加载（列表快速切歌时不重复请求）。 */
const inflight = new Map<string, Promise<boolean>>()

/**
 * 等待封面「已加载并解码完成」，供需要**换图首帧就有像素**的场景（如沉浸页背景）门控。
 *
 * - 已在登记表中 → 立即 resolve(true)；
 * - 成功 → 登记就绪（与 `preloadCover` 副作用一致）；失败 → resolve(false) 且**不**登记
 *   （失败的 URL 不进登记表，`Cover` 仍能走自己的失败兜底）；
 * - 同一 URL 并发等待共享同一次加载。
 */
export function whenCoverReady(src: string): Promise<boolean> {
  // 判断与去重用规范化键；实际下载仍用原始地址（任一镜像主机皆可取到同一文件）
  const k = key(src)
  if (ready.has(k)) return Promise.resolve(true)
  let p = inflight.get(k)
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      const img = new Image()
      const settle = (ok: boolean) => {
        inflight.delete(k)
        if (ok) markCoverReady(src)
        resolve(ok)
      }
      img.onload = () => {
        // decode 把解码也提前做完——未解码的大图首绘可能被浏览器推迟。无 decode 的
        // 环境（jsdom）退化为 onload 即就绪。
        if (typeof img.decode === 'function')
          img.decode().then(
            () => settle(true),
            () => settle(false),
          )
        else settle(true)
      }
      img.onerror = () => settle(false)
      img.src = src
    })
    inflight.set(k, p)
  }
  return p
}

/** 预取并解码封面，就绪后登记（失败忽略）。幂等。 */
export function preloadCover(src?: string): void {
  if (!src) return
  void whenCoverReady(src)
}

/** 清空登记表与进行中的加载（供测试 / 重置使用）。 */
export function clearCoverRegistry(): void {
  ready.clear()
  inflight.clear()
}

// 自注册到统一清缓存：新增内存缓存不必再改 clearCaches 的清单
registerCacheCleaner(clearCoverRegistry)
