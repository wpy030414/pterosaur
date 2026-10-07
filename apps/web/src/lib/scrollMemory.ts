/**
 * 内容区滚动位置记忆：以**历史条目**为键（`location.key`）。
 *
 * 前进（下钻 / 侧边栏 / 新开链接）会压入**新**条目 → 新 key → 从顶部开始；
 * 后退 / 前进（POP）复用**旧**条目 → 同 key → 恢复其保存的位置。
 * 因此「同一页里不断下钻再返回」自动回到原处，而「从侧边栏新开」自然从头开始。
 *
 * 关键点：用**同步**维护的 `currentKey` 决定「当前滚动该记到哪个条目名下」，
 * 而非给每个条目各挂一个 scroll 监听——否则导航时新旧监听器的切换时机（被动 effect 落后于
 * 布局 effect）会让归零滚动被记到错误的条目上。
 */

const positions = new Map<string, number>()

/** 当前所处的历史条目 key（由布局 effect 在提交时同步更新）。 */
let currentKey: string | null = null

/**
 * 是否记录滚动。**导航转场期间暂停**：`startViewTransition` 在回调（新条目提交）之前
 * 要捕获旧快照，该渲染步骤里浏览器可能对被命名的滚动容器产生**钳制滚动**（实测搜索页
 * 滚到 677 时被压到 5）——此刻 `currentKey` 仍是旧条目，scroll 事件会把旧条目的真实
 * 记录污染成钳制值，「下钻返回」于是回到顶部。转场提交（新 key 就位）后恢复记录。
 */
let savingEnabled = true

/** 暂停 / 恢复滚动记录（仅 `lib/viewTransition.ts` 的路由转场调用）。 */
export function setScrollSaving(on: boolean): void {
  savingEnabled = on
}

/** 设置当前条目 key（布局期同步调用）。 */
export function setCurrentScrollKey(key: string): void {
  currentKey = key
}

/** 把某次滚动记到**当前条目**名下。 */
export function saveCurrentScroll(top: number): void {
  if (!savingEnabled) return
  if (currentKey) positions.set(currentKey, top > 0 ? top : 0)
}

/** 取某历史条目的滚动位置；未知条目返回 0（即顶部）。 */
export function savedScroll(key: string): number {
  return positions.get(key) ?? 0
}

/** 清空全部记忆（测试用）。 */
export function clearScrollMemory(): void {
  positions.clear()
  currentKey = null
}
