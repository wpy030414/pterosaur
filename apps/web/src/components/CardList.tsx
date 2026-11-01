import { useCallback, useLayoutEffect, useRef } from 'react'
import { columnsFor, rowAvailable } from './listLayout.js'
import './Cards.css'

interface CardListProps {
  /**
   * 排布形态：
   * - `grid`：纵向栅格（列数由可用宽度算出，封面不小于 185px）；
   * - `row`：横向单排（与纵向同样的封面宽，超出即可横向滚动，右侧露出下一列一角），
   *   须放进 `Rail` 使用。
   */
  layout?: 'grid' | 'row'
  /** 附加类名 */
  className?: string
  children: React.ReactNode
}

/**
 * 卡片列表的统一容器（**只管排布**，不含标题头与翻页按钮——那些属 `Rail` 的职责）。
 *
 * 排布规则（横纵一致）：
 * - 封面宽 ≥ 185px（列数由它和可用宽度共同决定，屏越宽列越多）；
 * - 列数 = ⌊(可用宽度 + 列距) ÷ (185 + 列距)⌋，且每行最多 6 列
 *   （横向时「露出的一部分」也算一列）；
 * - 封面宽 = (可用宽度 − 列距 × (列数 − 1)) ÷ 列数。
 *
 * 横向时可用宽度 = Rail 可视宽 **再扣一列间距**，于是第 7 列（或首列的下一列）会在
 * 右边缘露出一角，提示还能继续横滑（与 Apple Music 一致）。
 *
 * 计算放在 JS 而不是 CSS：列数需要向下取整并作为 `repeat()` 的次数，纯 CSS 做不干净
 * （`round()` / `min()` 参与 `repeat()` 次数时各浏览器表现不一，且无法稳健兜底）。
 * `--card-cols` / `--card-cell` 由 ResizeObserver 写入内联样式，未测量前沿用 CSS 兜底值。
 */
export function CardList({
  layout = 'grid',
  className,
  children,
}: CardListProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const row = layout === 'row'
    /*
     * 可用整宽：横向取 Rail 滚动容器的可视宽（扣其左右内边距），纵向取列表自身宽度。
     * 列数 / 列宽的计算与横向 TrackList 共用 `columnsFor`，保证二者列对齐。
     */
    const available = row ? rowAvailable(el.parentElement) : el.clientWidth
    const { cols, cell } = columnsFor(available, row)
    el.style.setProperty('--card-cols', String(cols))
    el.style.setProperty('--card-cell', `${cell}px`)
  }, [layout])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    // 纵向盯自身宽度；横向盯滚动容器（自身宽度会随内容增长，不能用来测量）
    const target = layout === 'row' ? el.parentElement : el
    if (!target || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(target)
    return () => ro.disconnect()
  }, [layout, measure])

  return (
    <div
      ref={ref}
      className={`card-list card-list--${layout}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}
