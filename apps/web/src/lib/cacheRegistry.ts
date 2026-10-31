/**
 * 进程内内存缓存的**统一登记处**。
 *
 * 此前登录 / 退出时的清缓存是一份手写清单（歌词 / 封面登记 / 取数 / 预载去重），
 * 新增一个内存缓存就要记得回来改一处——漏掉即是「留着旧身份的数据」的隐蔽 bug。
 * 改为各模块在自己的文件里 `registerCacheCleaner()`，清缓存时统一遍历。
 *
 * 只登记**内存**缓存；IDB 离线保存与 Cache Storage 有明确的单一所有者
 * （`mediaCache` / `pwa`），由 `clearCaches` 直接调用，无需登记。
 * 封面不进应用层缓存（交给浏览器 HTTP 缓存，见 ADR-060），故这里只剩「就绪登记表」
 * 这类内存态。
 */

type Cleaner = () => void

const cleaners = new Set<Cleaner>()

/** 登记一个清理函数；返回注销函数（模块卸载 / 测试用）。 */
export function registerCacheCleaner(fn: Cleaner): () => void {
  cleaners.add(fn)
  return () => cleaners.delete(fn)
}

/** 依次执行全部已登记的清理函数；单个失败不影响其余。 */
export function clearRegisteredCaches(): void {
  for (const fn of cleaners) {
    try {
      fn()
    } catch (err) {
      console.warn('[cache] 清理内存缓存失败', err)
    }
  }
}

/** 已登记的清理函数个数（测试用）。 */
export function registeredCacheCount(): number {
  return cleaners.size
}
