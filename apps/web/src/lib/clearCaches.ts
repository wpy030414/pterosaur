/**
 * 登录 / 退出登录时清空**全部缓存**（见 ADR-034、ADR-060）。
 *
 * 背景：离线保存与 App 外壳都**不带「登录身份」维度**——SW 的消息协议按 `source:id|level`
 * 落盘，后端 URL 缓存虽带凭证指纹、但前端复用同一份。故凭证一变（登入 / 登出），旧内容
 * （例如匿名时保存的 30 秒试听）会被错误复用，表现为「没登录 / 登录后仍只放一小段」。
 * 因此在凭证变化时清空缓存，让新身份下重新解析、重新保存。
 *
 * 清空范围：IDB 离线保存 + SW 内存索引 + Cache Storage（应用外壳 / 图标）+ 进程内内存缓存
 * （歌词 / 封面就绪登记 / 预载去重表 / `useAsync` 取数）。
 * **不动**资料库（收藏 / 歌单，属用户数据）与登录态本身。
 *
 * 封面不在本系统的应用层缓存里（交给浏览器 HTTP 缓存，ADR-060），故这里没有「清封面」一项。
 */
import { clearOfflineAudio } from './mediaCache.js'
import { clearRegisteredCaches } from './cacheRegistry.js'
import {
  clearAllCaches as clearCacheStorage,
  postToServiceWorker,
} from './pwa.js'

/** 清空本系统的全部缓存（凭证变化时调用；不影响资料库与登录态）。 */
export async function clearAllAppCaches(): Promise<void> {
  // 1) IDB 离线保存 + SW 内存里的索引
  try {
    await clearOfflineAudio()
  } catch (err) {
    console.warn('[cache] 清空离线保存失败', err)
  }
  postToServiceWorker({ type: 'MEDIA_CACHE_CLEARED' })
  // 播放侧可能正持有 blob: 地址：通知它切回流地址并释放（否则播到的是已删的字节）
  window.dispatchEvent(new Event('offline-audio-cleared'))
  // 2) Cache Storage：应用外壳 / 图标
  await clearCacheStorage()
  // 3) 进程内内存缓存：由各模块自注册（歌词 / 封面登记 / 取数 / 预载去重…）
  //    新增内存缓存只需在自己的模块里 registerCacheCleaner()，不必回来改这里
  clearRegisteredCaches()
}
