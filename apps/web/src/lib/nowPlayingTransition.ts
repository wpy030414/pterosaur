import { flushSync } from 'react-dom'
import { usePlayerUi } from '../store/playerUi.js'
import {
  supportsViewTransition,
  prefersReducedMotion,
  nextFrame,
} from './viewTransition.js'

/**
 * 沉浸播放页（NowPlaying）的共享元素转场。
 *
 * 展开 / 收起时用浏览器的 View Transitions API 让底部播放栏的小封面「放大」为
 * 沉浸页的大封面（两侧都以 `view-transition-name: np-cover` 命名，同一时刻只有
 * 一个元素持名 ⇒ 旧快照=小封面、新快照=大封面，浏览器在小/大矩形间做几何 morph）。
 * 背景 / 面板的淡入上浮由 `.nowplaying` 上的 live CSS 动画承担（见 NowPlaying.css）。
 *
 * 不支持该 API、或用户偏好减少动效时，退化为直接的同步状态切换。
 *
 * 关键：转场期间给 `<html>` 打上 `data-np-vt`（供 CSS / 观测引用）。`.app-content` 默认即
 * `view-transition-name: none`（见 app.css），故沉浸转场期间它本就不参与快照——无需临时摘名，
 * 也就不会出现「转场结束后恢复命名、其快照与伪树拆除赛跑」而导致的封面错位。
 */

/** View Transitions API 的最小结构（避免依赖 lib 是否含 `ViewTransition` 类型）。 */
interface ViewTransitionLike {
  finished: Promise<void>
  skipTransition: () => void
}

/** 当前进行中的沉浸页转场（用于连点保护）。 */
let active: ViewTransitionLike | null = null

/**
 * 展开 / 收起沉浸播放页，尽量走共享元素转场。
 *
 * @param next 目标状态（true 展开，false 收起）
 */
export function startNowPlayingTransition(next: boolean): void {
  const setExpanded = () => usePlayerUi.getState().setExpanded(next)

  if (!supportsViewTransition() || prefersReducedMotion()) {
    flushSync(setExpanded)
    return
  }

  const root = document.documentElement
  // 必须在 startViewTransition 之前就绪：旧快照拍摄时 CSS 需已摘掉 .app-content 的命名
  root.dataset.npVt = next ? 'open' : 'close'

  // 连点：丢弃上一段未完成的转场，避免两段叠加导致中途跳变
  active?.skipTransition()

  const doc = document as Document & {
    startViewTransition: (cb: () => void | Promise<void>) => ViewTransitionLike
  }
  let transition: ViewTransitionLike
  try {
    // 回调必须**同步**提交 DOM：在回调里 await rAF 会死锁（转场期间浏览器暂停渲染，
    // 回调等 rAF、rAF 等回调结束 → 超时中止，并连带破坏控件滚动）。故这里不 await 任何东西。
    transition = doc.startViewTransition(() => {
      flushSync(setExpanded)
    })
  } catch {
    // 抛错（如文档非 fully-active）：清掉标记并回退为直接切换，避免标记永久残留
    delete root.dataset.npVt
    flushSync(setExpanded)
    return
  }
  active = transition

  // finished 在 skipTransition 时会以 AbortError reject，两分支都要清理；
  // 且只清理「仍是当前这段」的标记，避免被已 skip 的旧转场误删。
  //
  // 标记的清除**推迟到下一帧**：`finished` 解析时伪树仍在拆除，此刻改样式会触发快照重建
  // （内容区封面落在旧几何、滚动/点击后才复位），故等拆除完毕再动。
  const done = () =>
    nextFrame(() => {
      if (active !== transition) return
      active = null
      delete root.dataset.npVt
    })
  transition.finished.then(done, done)
}
