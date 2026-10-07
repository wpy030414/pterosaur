import type { ReactNode } from 'react'
import './Cards.css'

/**
 * 磁带外壳。
 *
 * 结构：外壳面 → **4:3 视频窗**（`children`，即封面 / chip / 播放按钮）→ **卷轴带**（内凹深色带 +
 * 两枚卷轴 + 其间磁带）。磁带身份靠「视窗在上、双卷轴在下」的版式，整体沿用应用的中性面板语言
 * （见 `Cards.css` 的 `.cassette-shell` 一组规则 / ADR-044）。
 *
 * 卡片（`CassetteCard`）与详情页 hero（`Playlist.tsx`）共用，保证两处观感一致；详情页只需在
 * `.detail__art--cassette` 上调 `--cs` 细部倍率。
 */
export function CassetteShell({ children }: { children: ReactNode }) {
  return (
    <div className="cassette-shell">
      {/* 视频窗：chip 与播放按钮以它为定位参照（position: relative） */}
      <div className="cassette-shell__window">{children}</div>
      {/* 卷轴带：两枚卷轴 + 其间磁带 */}
      <div className="cassette-shell__deck" aria-hidden>
        <span className="cassette-shell__tape" />
        <span className="cassette-reel" />
        <span className="cassette-reel" />
      </div>
    </div>
  )
}
