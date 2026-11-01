import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CardList } from './CardList.js'
import './Rail.css'

interface RailProps {
  /** 分区标题（「推荐歌单」「新歌精选」…）。 */
  title: string
  /** 标题右侧的次要说明（如「Apple Music 热门」）。 */
  subtitle?: string
  /** 标题右侧的操作（如「查看全部」）。 */
  action?: ReactNode
  children: ReactNode
  /** 单张卡片的预估宽度（px），用于翻页步长。 */
  itemWidth?: number
  /**
   * 横向排布形态：
   * - `row`：单排（缺省）——卡片 / 曲目行横排一条；
   * - `grid`：多列纵向网格——曲目行矮，单行会浪费大段高度（**曲目型分区**）；
   * - `cards`：单排卡片，子项由内部 `CardList` 排布（**卡片型分区**，推荐写法）。
   *
   * 与 `CardList` / `TrackList` 的 `layout` 同义；区分只为让 Rail 知道要不要自己套 `CardList`。
   * @deprecated 用 `layout="grid"` 代替布尔属性 `grid`。
   */
  layout?: 'row' | 'grid' | 'cards'
  /** @deprecated 用 `layout="grid"`。 */
  grid?: boolean
}

/**
 * 横向滚动分区（Apple Music 网页版发现流的基本单元）。
 *
 * 发现页把大量不同类型的区块纵向堆叠，若每块都用网格，页面会极长且难以扫读；
 * 改为「每块内部横向滚动」后，纵向只保留 N 个章节标题，信息密度与可浏览性都好得多。
 *
 * 交互：
 * - 原生横向滚动（触控板 / 触摸直接可用）；
 * - 鼠标悬停时左右两侧浮出翻页按钮（滚动到尽头的一端自动隐藏）；
 * - 按钮翻一「屏」（按容器宽度取整张数），并自动聚焦首张卡片。
 */
export function Rail({
  title,
  subtitle,
  action,
  children,
  itemWidth = 180,
  layout = 'row',
  grid = false,
}: RailProps) {
  // 旧布尔属性仍可用：只要显式传了 grid 就以它为准（可 false 覆盖 layout="grid"）
  const mode = layout === 'grid' || grid ? 'grid' : layout
  const isGrid = mode === 'grid'
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  /** 重新计算两端是否已到尽头（决定翻页按钮显隐）。 */
  const syncEdges = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // 1px 容差：缩放 / 亚像素布局下 scrollLeft 常差零点几像素
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    syncEdges()
    el.addEventListener('scroll', syncEdges, { passive: true })
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(syncEdges)
        : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', syncEdges)
      ro?.disconnect()
    }
  }, [syncEdges, children])

  const page = (dir: 1 | -1) => {
    const el = scrollerRef.current
    if (!el) return
    // 翻一屏，但按整张卡片对齐，避免半张卡片卡在边缘
    const perScreen = Math.max(1, Math.floor(el.clientWidth / itemWidth))
    const delta = perScreen * itemWidth * dir
    el.scrollBy({ left: delta, behavior: 'smooth' })
  }

  return (
    <section className="rail">
      <header className="rail__head">
        <div className="rail__titles">
          <h2 className="rail__title">{title}</h2>
          {subtitle && <p className="rail__subtitle">{subtitle}</p>}
        </div>
        <div className="rail__action">{action}</div>
      </header>

      <div className="rail__viewport">
        <button
          type="button"
          className={`rail__arrow rail__arrow--prev${atStart ? ' rail__arrow--hidden' : ''}`}
          onClick={() => page(-1)}
          aria-label="向左滚动"
          tabIndex={atStart ? -1 : 0}
        >
          <ChevronLeft size={20} strokeWidth={2.4} />
        </button>

        <div
          className={`rail__scroller${isGrid ? ' rail__scroller--grid' : ''}`}
          ref={scrollerRef}
        >
          {/* 卡片型分区：Rail 自套统一容器；曲目行（TrackList）自行排布，不再包一层 */}
          {mode === 'cards' ? (
            <CardList layout="row">{children}</CardList>
          ) : (
            children
          )}
        </div>

        <button
          type="button"
          className={`rail__arrow rail__arrow--next${atEnd ? ' rail__arrow--hidden' : ''}`}
          onClick={() => page(1)}
          aria-label="向右滚动"
          tabIndex={atEnd ? -1 : 0}
        >
          <ChevronRight size={20} strokeWidth={2.4} />
        </button>
      </div>
    </section>
  )
}
