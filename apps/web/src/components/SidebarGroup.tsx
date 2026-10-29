import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { SidebarGroupKey } from '../store/sidebarPrefs.js'
import { useSidebarGroupOpen, useSidebarPrefs } from '../store/sidebarPrefs.js'

interface SidebarGroupProps {
  /** 分组标识（决定持久化的展开态）。 */
  groupKey: SidebarGroupKey
  /** 分组标题（「库」/「歌单」）。 */
  label: string
  /** 标题右侧的额外操作（如「新建歌单」的 + 按钮）。 */
  action?: ReactNode
  children: ReactNode
}

/**
 * 侧边栏可折叠分组。
 *
 * 标题本身是按钮：点击切换展开 / 收起，展开态持久化在 `store/sidebarPrefs`。
 * 收起时子项**条件卸载**而非仅隐藏——这样键盘 Tab 序列不会经过不可见项，
 * 也避免折叠区仍占位。
 */
export function SidebarGroup({
  groupKey,
  label,
  action,
  children,
}: SidebarGroupProps) {
  const open = useSidebarGroupOpen(groupKey)
  const toggle = useSidebarPrefs((s) => s.toggleGroup)
  const bodyId = useId()

  return (
    <div className={`sidebar__group${open ? '' : ' sidebar__group--closed'}`}>
      <div className="sidebar__group-head">
        <button
          type="button"
          className="sidebar__group-toggle"
          onClick={() => toggle(groupKey)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <ChevronRight size={14} strokeWidth={2.4} className="sidebar__chev" />
          <span>{label}</span>
        </button>
        {action && <div className="sidebar__group-action">{action}</div>}
      </div>

      {open && (
        <nav id={bodyId} className="sidebar__nav" aria-label={label}>
          {children}
        </nav>
      )}
    </div>
  )
}
