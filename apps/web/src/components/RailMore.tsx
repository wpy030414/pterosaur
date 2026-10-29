import { ChevronRight } from 'lucide-react'
import { AppLink } from './AppLink.js'
import './RailMore.css'

interface RailMoreProps {
  /** 目标地址（独立类别页，如 `/search/songs?q=…`）。 */
  to: string
  /** 类别中文名（「歌曲」「磁带」…），用于提示文案与无障碍标签。 */
  label: string
}

/**
 * 分区标题行右侧的「更多」文字按钮（传进 `Rail` 的 `action` 槽）。
 *
 * 搜索页每个分区只放一页结果，剩下的去独立类别页看。入口放在**标题行**而不是
 * 滑轨末尾：末尾塞一张大卡会打断卡片流的节奏，且得一路滑到头才看得见。
 */
export function RailMore({ to, label }: RailMoreProps) {
  return (
    <AppLink
      to={to}
      className="rail-more"
      aria-label={`查看全部${label}`}
      data-testid="rail-more"
    >
      更多
      <ChevronRight size={16} strokeWidth={2.2} aria-hidden />
    </AppLink>
  )
}
