/**
 * 登录 / 退出登录时清空**全部缓存**（见 ADR-034）。
 *
 * 背景：媒体缓存（音频 / 封面）与 App 外壳都**不带「登录身份」维度**——SW 的音频键是
 * `source:id|level`（见 ADR-025），后端 URL 缓存虽带凭证指纹、但前端 SW 复用同一份。故凭证
 * 一变（登入 / 登出），旧缓存（例如匿名时缓存的 30 秒试听）会被错误复用，表现为「没登录 / 登录后
 * 仍只放一小段」。因此在凭证变化时清空缓存，让新身份下重新解析。
 *
 * 清空范围：IDB 媒体池（音频 + 封面）+ Service Worker 内存元数据索引 + Cache Storage
 * （应用外壳 / 图标）+ 进程内内存缓存（歌词 / 封面就绪登记 / 预载去重表 / `useAsync` 取数）。
 * **不动**资料库（收藏 / 歌单，属用户数据）与登录态本身。
 */
import { clearMediaCache } from './mediaCache.js'
import { clearLyricCache } from './lyricCache.js'
import { clearCoverRegistry } from './imageCache.js'
import { clearPrefetchRegistry } from './prefetch.js'
import {
  clearAllCaches as clearCacheStorage,
  postToServiceWorker,
} from './pwa.js'
import { clearAsyncCache } from '../hooks/useAsync.js'

/** 清空本系统的全部缓存（凭证变化时调用；不影响资料库与登录态）。 */
export async function clearAllAppCaches(): Promise<void> {
  // 1) IDB 媒体池（音频 + 封面）+ SW 内存里的元数据索引
  try {
    await clearMediaCache()
  } catch (err) {
    console.warn('[cache] 清空媒体缓存失败', err)
  }
  postToServiceWorker({ type: 'MEDIA_CACHE_CLEARED' })
  // 2) Cache Storage：应用外壳 / 图标
  await clearCacheStorage()
  // 3) 进程内内存缓存
  clearLyricCache()
  clearCoverRegistry()
  clearAsyncCache()
  // 媒体池已清空，页面侧「已预载」记录必须同步清：否则重登后会误判「已预载」而不再重发
  clearPrefetchRegistry()
}
