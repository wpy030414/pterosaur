import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Router, UNSAFE_createBrowserHistory } from 'react-router-dom'
import { startRouteTransition } from '../lib/viewTransition.js'

type History = ReturnType<typeof UNSAFE_createBrowserHistory>
type HistoryListener = Parameters<History['listen']>[0]
type HistoryUpdate = Parameters<HistoryListener>[0]

/**
 * 读当前历史条目的序号。react-router 的 history 把 `idx` 写在 `window.history.state`：
 * push 使其 +1、back/forward 使其减/增，据此判定前进 / 后退。
 */
function readIdx(): number {
  const s = window.history.state as { idx?: number } | null
  return typeof s?.idx === 'number' ? s.idx : 0
}

/**
 * 自定义路由器：等价于 `<BrowserRouter>`，但把**所有**历史变更（含 popstate 前进 / 后退）
 * 统一包进内容区 View Transition 转场（见 `lib/viewTransition.ts` 的 `startRouteTransition`）。
 *
 * 动机：`<BrowserRouter>` 的 `history.listen(setState)` 更新是异步的（popstate 尤甚），无法像
 * 「跳转新地址」那样由 `useViewNavigate` 同步包裹 `startViewTransition`，于是顶栏前进 / 后退
 * 此前没有转场。这里把转场上移到路由器层：无论 push 还是 pop，都在 `history.listen` 回调里提交
 * 状态；并按历史序号增减决定动画正放（前进）/ 逆放（后退）。
 *
 * 形状与 react-router 的 `BrowserRouter` 一致（用 `useRef` 惰性建 history，避免 StrictMode
 * 双次渲染重复创建连接）。
 */
export function AppRouter({ children }: { children?: ReactNode }) {
  const historyRef = useRef<History | null>(null)
  if (historyRef.current == null) {
    historyRef.current = UNSAFE_createBrowserHistory({ v5Compat: true })
  }
  const history = historyRef.current

  const [state, setState] = useState(() => ({
    action: history.action,
    location: history.location,
  }))
  const lastIdx = useRef(readIdx())

  useLayoutEffect(() => {
    const onHistoryChange = (next: HistoryUpdate) => {
      const idx = readIdx()
      const dir: 'forward' | 'back' = idx < lastIdx.current ? 'back' : 'forward'
      lastIdx.current = idx
      startRouteTransition(
        () => setState({ action: next.action, location: next.location }),
        dir,
      )
    }
    return history.listen(onHistoryChange)
  }, [history])

  return (
    <Router
      location={state.location}
      navigationType={state.action}
      navigator={history}
    >
      {children}
    </Router>
  )
}
