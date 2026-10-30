import { Menu } from 'lucide-react'
import { useSidebarDrawer } from '../store/ui.js'
import './MobileMenuButton.css'

/**
 * 窄屏浮动汉堡按钮。
 *
 * 顶栏移除后，侧边栏在 ≤768px 变成抽屉（权威边界，见 tokens.css / ADR-059），原先由顶栏提供的开关就没有落脚点了。
 * 这里让它浮在内容区左上角（毛玻璃圆形），点击展开抽屉。桌面（>768px）恒隐藏。
 */
export function MobileMenuButton() {
  const toggleSidebar = useSidebarDrawer((s) => s.toggleSidebar)
  return (
    <button
      type="button"
      className="mobile-menu-btn"
      onClick={toggleSidebar}
      aria-label="打开侧边栏"
    >
      <Menu size={19} strokeWidth={2} />
    </button>
  )
}
