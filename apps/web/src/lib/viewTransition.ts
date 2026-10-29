import { flushSync } from 'react-dom'
import { setScrollSaving } from './scrollMemory.js'

/**
 * 路由切换辅助。
 *
 * 历史：本项目曾用 `document.startViewTransition` 给内容区做 Apple Music 风格交叉溶解
 * （声明式 `<BrowserRouter>` 下无法用 react-router v7 的 `viewTransition` 选项，故自行实现）。
 * 该转场现已停用——原因见 `startRouteTransition` 的说明。这里保留的 `supportsViewTransition`
 * / `prefersReducedMotion` / `nextFrame` 仍被主题转场与沉浸播放转场复用。
 */

/** 内容滚动容器（路由切换时需重置滚动位置；声明式路由不会自动重置）。 */
function contentEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.app-content')
}

function resetContentScroll() {
  const el = contentEl()
  if (!el) return
  // 容器带 scroll-behavior: smooth，直接改 scrollTop 会被动画化，这里临时关掉以求瞬时归零
  const prev = el.style.scrollBehavior
  el.style.scrollBehavior = 'auto'
  el.scrollTop = 0
  el.style.scrollBehavior = prev
}

/** 是否支持原生 View Transition（用于决定启用 CSS 降级进场动画）。 */
export function supportsViewTransition(): boolean {
  return (
    typeof (document as Document & { startViewTransition?: unknown })
      .startViewTransition === 'function'
  )
}

/** 用户是否偏好减少动效。 */
export function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
}

/**
 * 在**下一帧**执行回调（优先 rAF）。
 *
 * 用于把「转场结束后清除瞬态标记」推迟到伪树拆除之后——若在 `finished` 解析的同一刻清标记，
 * 浏览器会在拆除过程中重建快照，使内容区封面落在旧几何。无 rAF 的环境（部分测试 / SSR）
 * 退化为 `setTimeout(…, 0)`。
 */
export function nextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
  else setTimeout(cb, 0)
}

/**
 * 执行一次路由更新，**不带**内容区 View Transition 动画。
 *
 * 为什么停用：播放岛（`.playerbar`）是普通层叠里的悬浮元素，而 View Transition 的内容快照
 * 绘制在浏览器 top layer，转场期间必然压在播放岛之上——切页瞬间播放岛被底部内容盖住。
 * 若把岛也纳入快照让它重新浮上来，快照又会把岛栅格化成图片：`backdrop-filter` 找不到
 * 真实背景，毛玻璃随即塌成半透明。两条路都会破坏观感，故路由切换改为瞬时替换，
 * 播放岛始终稳定在上一层、玻璃通透如常。
 *
 * 主题转场与沉浸播放转场不受影响（各自独立，见 lib/themeTransition.ts / nowPlayingTransition.ts）；
 * 不支持 View Transition 的浏览器仍由 app.css 的降级进场动画提供过渡。
 *
 * 仍然保留的两处时序处理：
 *  - `flushSync` 提交：让滚动恢复的布局 effect 先于归零执行，否则归零会把旧条目位置记成 0。
 *  - `flushSync` 之后才 `setScrollSaving(true)`：此后滚动归属新条目。
 *
 * @param dir `forward`（前进，默认）或 `back`（后退）。写入 `data-route-dir`，
 *   供 app.css 的降级进场动画决定正放 / 逆放。
 * @param opts.skip 仍受尊重：路径不变的同页变更（如仅改查询串的切 tab）不写入方向标记。
 */
export function startRouteTransition(
  update: () => void,
  dir: 'forward' | 'back' = 'forward',
  opts: { skip?: boolean } = {},
): void {
  const root = document.documentElement
  // 不支持 VT 的浏览器靠这个标记驱动降级进场动画；同页切换不该触发它。
  if (opts.skip) delete root.dataset.routeDir
  else root.dataset.routeDir = dir

  setScrollSaving(false)
  flushSync(update)
  setScrollSaving(true)
  if (dir === 'forward' && !opts.skip) resetContentScroll()
}
