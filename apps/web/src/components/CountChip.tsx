interface CountChipProps {
  /** 集合内的曲目数（磁带为分P 数）。`undefined` 或 ≤ 1 时不渲染。 */
  count?: number
  /** 单位后缀（默认「首」）。 */
  unit?: string
}

/**
 * 卡片封面右上角的「曲目数量」chip。
 *
 * 仅当数量**已知且 > 1** 时显示——单曲 / 空集合 / 数量未知都不显示（见 ADR-044）。纯展示，
 * `pointer-events: none`（见 `Cards.css`），不会与卡片本体点击 / 悬浮播放按钮争抢事件。
 */
export function CountChip({ count, unit = '首' }: CountChipProps) {
  if (typeof count !== 'number' || count <= 1) return null
  return (
    <span className="card__count" title={`共 ${count} ${unit}`}>
      {count}
      {unit ? ` ${unit}` : ''}
    </span>
  )
}
