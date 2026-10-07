import { BACKGROUND_STORE, idbDelete, idbGet, idbPut } from './idb.js'

/**
 * 自定义应用背景的**媒体本体**存取（IndexedDB）。
 *
 * localStorage 只有 ~5MB 且为字符串，放图片 / 视频不现实，故媒体本体落 IndexedDB 的专用
 * `background` store（单条，key 固定），settings store 里只留轻量元数据（见 `store/settings`）。
 *
 * object URL 进程内缓存一份（{@link getBackgroundUrl}），避免每次渲染重复 createObjectURL；
 * 背景变更后由 {@link saveBackground} / {@link removeBackground} 失效缓存。
 */

/** 固定存储键（单条背景）。 */
export const BACKGROUND_KEY = 'app-background'

let url: string | null = null
let loading: Promise<string | null> | null = null

/** 同步取得「已加载好的」背景 object URL（未加载则为 null）。 */
export function currentBackgroundUrl(): string | null {
  return url
}

/** 载入并缓存背景 object URL（懒加载；已加载则直接返回）。无存储层时返回 null。 */
export function getBackgroundUrl(): Promise<string | null> {
  if (url) return Promise.resolve(url)
  if (!loading) {
    loading = idbGet<Blob>(BACKGROUND_STORE, BACKGROUND_KEY)
      .then((blob) => {
        loading = null
        if (!blob) return null
        url = URL.createObjectURL(blob)
        return url
      })
      .catch(() => {
        loading = null
        return null
      })
  }
  return loading
}

/** 失效 object URL 缓存（背景变更 / 清除后调用）。 */
export function invalidateBackgroundUrl(): void {
  if (url) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* 忽略 */
    }
  }
  url = null
  loading = null
}

/** 保存新的背景媒体本体（覆盖旧的）；写入后**校验确实落库**，失败则抛出。 */
export async function saveBackground(blob: Blob): Promise<void> {
  invalidateBackgroundUrl()
  await idbPut(BACKGROUND_STORE, blob, BACKGROUND_KEY)
  // `idbPut` 在 store 缺失 / IDB 不可用时会静默降级为 no-op，故这里读回校验；
  // 失败即抛出，避免留下「设置了背景却看不到图」的幽灵状态（调用方据抛出决定不落配置）。
  const stored = await idbGet<Blob>(BACKGROUND_STORE, BACKGROUND_KEY)
  if (!stored) throw new Error('背景写入失败（IndexedDB 不可用或 background store 缺失）')
}

/** 删除背景媒体本体。 */
export async function removeBackground(): Promise<void> {
  invalidateBackgroundUrl()
  await idbDelete(BACKGROUND_STORE, BACKGROUND_KEY)
}
