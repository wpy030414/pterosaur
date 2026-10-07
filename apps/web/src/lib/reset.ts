import { clearAllCaches, unregisterServiceWorkers } from './pwa.js'
import {
  BACKGROUND_STORE,
  LIBRARY_STORE,
  MEDIA_META_STORE,
  MEDIA_STORE,
  idbClear,
} from './idb.js'

/**
 * 「重置」：清空**本机**的全部内容 —— IndexedDB（资料库 + 媒体缓存）、Cache Storage
 * （应用外壳）、Service Worker 注册，以及 localStorage / sessionStorage（播放偏好、
 * 主题、云同步开关等）。随后整页刷新，使运行期状态一并复位。
 *
 * **为何清空 store 而非删除整库**：生产下 Service Worker 常驻持有同一个 IndexedDB 连接，
 * `indexedDB.deleteDatabase()` 会被 `onblocked` 阻塞而静默失败；逐 store `clear()` 则不受
 * 其它连接影响，内容必然清空。库壳残留无影响（重载后会按需重建空 store）。
 *
 * **不动登录态**：网易云会话 cookie 由后端 Set-Cookie 下发，属 HTTP 层，本函数不清理它，
 * 故重置后仍处登录态。若需连同云端 library 一并清空，由调用方在重置前先推送空 library
 * （见 `lib/sync.ts` 的 `pushEmptyLibrary`）。
 *
 * `reload` 可注入以便单测（jsdom 无法真实 reload）。
 */
export async function resetAll(
  opts: { reload?: () => void } = {},
): Promise<void> {
  // 任一清理失败都不阻断其余清理与最终刷新
  await Promise.allSettled([
    Promise.allSettled([
      idbClear(LIBRARY_STORE),
      idbClear(MEDIA_STORE),
      idbClear(MEDIA_META_STORE),
      idbClear(BACKGROUND_STORE),
    ]),
    clearAllCaches(),
    unregisterServiceWorkers(),
  ])

  try {
    localStorage.clear()
  } catch {
    /* 忽略：隐私模式下可能不可写 */
  }
  try {
    sessionStorage.clear()
  } catch {
    /* 同上 */
  }

  ;(opts.reload ?? (() => location.reload()))()
}
