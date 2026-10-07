import { NavLink, useNavigate, type NavLinkProps } from 'react-router-dom'

/**
 * 包装 `NavLink`：左键点击时导航，并保留 active 样式。
 *
 * 内容区转场已**上移到路由器层**（见 `components/AppRouter.tsx`）：这里的 `navigate` 触发
 * 的 push 会在 `history.listen` 里被统一包进 View Transition，故此处无需再手动包裹。
 * 带修饰键（新标签页等）或非左键点击时保留浏览器默认行为。
 */
export function AppLink({ to, onClick, ...rest }: NavLinkProps) {
  const navigate = useNavigate()
  return (
    <NavLink
      to={to}
      onClick={(e) => {
        onClick?.(e)
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return
        e.preventDefault()
        navigate(to, { replace: rest.replace })
      }}
      {...rest}
    />
  )
}
