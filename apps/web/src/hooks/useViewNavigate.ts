import { useNavigate } from 'react-router-dom'

/**
 * 导航入口（薄封装）。
 *
 * 内容区转场已**上移到路由器层**（见 `components/AppRouter.tsx`）：无论「跳转新地址」（push）
 * 还是 popstate 前进 / 后退，都会在 `history.listen` 里被统一包进 View Transition。
 * 故此 hook 只需原样透传 `useNavigate`——保留它只为维持既有调用点、并集中一处说明转场归属。
 */
export function useViewNavigate() {
  return useNavigate()
}
