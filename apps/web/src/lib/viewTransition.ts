import { flushSync } from 'react-dom'
import { usePlayer } from '../store/player.js'
import {
  useQueuePanel,
  useCreatePlaylist,
  useConfirmDialog,
  useSidebarDrawer,
} from '../store/ui.js'
import { useAuth } from '../store/auth.js'
import { setScrollSaving } from './scrollMemory.js'

/**
 * 内容区转场（Apple Music 风格交叉溶解）。
 *
 * 说明：本项目使用**声明式 `<BrowserRouter>`**，而 react-router v7 的
 * `viewTransition` 选项只在数据路由（`RouterProvider`）下生效——声明式模式下
 * `useNavigate` 会把该选项交给 history，被其忽略（无转场、无告警）。
 * 因此这里自行调用浏览器的 `document.startViewTransition` 来实现转场。
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

/**
 * 是否存在会绘制在内容区之上的浮层。
 *
 * `::view-transition` 伪元素绘制在 top layer，会盖住 `position: fixed` 的
 * 队列面板 / 沉浸播放页 / 各类模态 / 移动端侧边栏抽屉。有浮层时直接放弃转场，
 * 避免盖层（典型表现：移动端由抽屉切换内容时，主内容跑到抽屉之上）。
 */
function hasBlockingOverlay(): boolean {
  return (
    usePlayer.getState().expanded ||
    useQueuePanel.getState().queueOpen ||
    useSidebarDrawer.getState().sidebarOpen ||
    useAuth.getState().modalOpen ||
    useCreatePlaylist.getState().open ||
    useConfirmDialog.getState().open
  )
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
 * 在 View Transition 包裹下执行一次路由更新。
 *
 * 满足以下任一条件时直接执行（不转场）：浏览器不支持该 API、用户偏好减少动效、
 * 当前有浮层打开。`flushSync` 确保 DOM 在startViewTransition 的更新回调内同步提交，
 * 这是 React 配合 View Transitions 的官方推荐做法。
 *
 * 路由转场令牌：连续导航时只让最新一段摘名，避免提前摘下内容区的命名。
 */
let routeToken = 0

/**
 * 在飞的转场。开新转场前先 `skipTransition()` 掐掉上一条——被中断的转场若放任自流，
 * 浏览器会把它的旧内容快照层留在 top layer 不拆（连续快速切换时表现为旧内容残影越积越多）。
 */
let activeTransition: { skipTransition?: () => void } | null = null

/**
 * 在 View Transition 包裹下执行一次路由更新。
 *
 * 满足以下任一条件时直接执行（不转场）：浏览器不支持该 API、用户偏好减少动效、
 * 当前有浮层打开。`flushSync` 确保 DOM 在startViewTransition 的更新回调内同步提交，
 * 这是 React 配合 View Transitions 的官方推荐做法。
 *
 * 转场期间给 `<html>` 打 `data-route-vt`——**只有路由转场**会让内容区（`.app-content`）
 * 参与快照（见 global.css / app.css）。主题与沉浸转场不命名它，故不会出现「转场结束后
 * 内容区恢复命名、其快照与伪树拆除赛跑」而导致的封面错位。
 *
 * @param dir 转场方向：`forward`（前进，默认）或 `back`（后退）。写入 `data-route-dir`，
 *   供 CSS 决定内容动画正放 / 逆放（后退 = 逆速度播放）。
 * @param opts.skip 强制走「不转场」分支（仍以 `flushSync` 提交、仍重置滚动、仍清标记）。
 *   用于**路径不变**的同页变更（如仅改查询串的切 tab）：那是页内状态切换、不是页面切换，
 *   为内容区拍一张旧快照盖上去只会留下上一屏的残影。
 *
 * 无论走哪条分支，都会先 `skipTransition()` 掐掉在飞的转场：否则旧快照会滞留在 top layer，
 * 盖住随后提交的新内容（见函数内注释）。
 */
export function startRouteTransition(
  update: () => void,
  dir: 'forward' | 'back' = 'forward',
  opts: { skip?: boolean } = {},
): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) =>
      | {
          finished?: Promise<void>
          skipTransition?: () => void
        }
      | undefined
  }
  const root = document.documentElement
  const token = ++routeToken

  /**
   * **任何**一次更新前，先掐掉在飞的转场。
   *
   * 关键：连「不转场」的路径也要掐——否则在**上一条路由转场还在跑**（如：下钻详情后返回，
   * 580ms 内）时点 tab，本次 `flushSync` 会直接在旧快照**底下**换掉内容，而那张旧快照仍
   * 盖在最上层继续画——表现为**上一屏（磁带）污染当前 tab**（艺人 / 专辑 / 歌单）。
   */
  activeTransition?.skipTransition?.()
  activeTransition = null

  // 转场结束后摘名；推迟到下一帧，躲开伪树拆除期（其间改样式会触发快照重建）。
  // 只清「仍是最新一段」的标记，避免快速连续导航时被旧转场提前摘名。
  const clearMarks = () =>
    nextFrame(() => {
      if (routeToken !== token) return
      delete root.dataset.routeVt
      delete root.dataset.routeDir
    })

  if (
    !doc.startViewTransition ||
    prefersReducedMotion() ||
    hasBlockingOverlay() ||
    opts.skip
  ) {
    // 非转场路径同样以 flushSync 提交：让滚动恢复的布局 effect 先于归零执行，
    // 否则归零会先跑、把旧条目的位置错误地记成 0。方向仍写入，供降级进场动画判断逆放。
    delete root.dataset.routeVt
    root.dataset.routeDir = dir
    setScrollSaving(false)
    flushSync(update)
    // 提交后新条目 key 已就位，此后滚动归属新条目，恢复记录
    setScrollSaving(true)
    if (dir === 'forward') resetContentScroll()
    clearMarks()
    return
  }

  // 仅路由转场命名内容区；必须在拍旧快照之前就绪
  root.dataset.routeVt = 'on'
  root.dataset.routeDir = dir

  /**
   * 暂停滚动记录：`startViewTransition` 在回调（新条目提交）之前捕获旧快照，该渲染
   * 步骤里浏览器可能对被命名的滚动容器产生**钳制滚动**（实测 677 被压到 5）——此刻
   * `currentKey` 仍是旧条目，会把旧条目的真实记录污染成钳制值（下钻返回即「回顶」，
   * 见 lib/scrollMemory 的 `setScrollSaving`）。提交完成（新 key 就位）后恢复。
   */
  setScrollSaving(false)
  const resumeSaving = () => setScrollSaving(true)

  let transition:
    | {
        finished?: Promise<void>
        skipTransition?: () => void
      }
    | undefined
  try {
    transition = doc.startViewTransition(() => {
      flushSync(update)
      resumeSaving()
      // 新内容就位后立即回到顶部，保证新快照从顶部开始。
      // **后退不归零**：后退要回到历史条目的原滚动位置，归零会把它记成 0（滚动恢复失效）。
      if (dir === 'forward') resetContentScroll()
    })
  } catch {
    // 抛错（如文档非 fully-active）：回退为直接切换并摘掉命名标记（方向留待 clearMarks 清理）
    delete root.dataset.routeVt
    flushSync(update)
    resumeSaving()
    if (dir === 'forward') resetContentScroll()
    clearMarks()
    return
  }

  activeTransition = transition ?? null
  const settled = () => {
    if (activeTransition === transition) activeTransition = null
    clearMarks()
  }
  if (transition?.finished) transition.finished.then(settled, settled)
  else settled()
}
