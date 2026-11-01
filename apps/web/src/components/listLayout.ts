/** 横向 / 纵向列表共用的排版常量。 */
/** 封面最小宽（px）。 */
export const COVER_MIN = 185
/** 每行最多列数（横向含只露出一部分的那一列）。 */
export const COLS_MAX = 6
/** 列间距（px），须与 Cards.css / TrackList.css 的列距一致。 */
export const GAP = 16
/** 横向时下一列露出的宽度（px）。 */
export const PEEK = 48

/**
 * 列宽与列数。
 * - `cols`：该行放几列；
 * - `cell`：每列宽（含封面，卡片无内边距）。
 */
export interface Columns {
  cols: number
  cell: number
}

/**
 * 按可用宽度算列数与列宽（**CardList 与横向 TrackList 共用，保证两者列对齐**）。
 *
 * - 封面最小 185px，每行最多 6 列（横向时「只露出一部分的那一列」也计入）；
 * - 横向：优先排满 6 列，每列再让出露头宽度（PEEK）；只有这样会让封面低于 185px 才减列；
 * - 纵向：按「至少 185px」算列数，再封顶 6。
 *
 * @param available 可用整宽（px）
 * @param row 是否横向（横向需扣露头）
 */
export function columnsFor(available: number, row: boolean): Columns {
  const usable = row ? available - PEEK : available
  const byWidth = Math.floor((usable + GAP) / (COVER_MIN + GAP))
  const byMax = row
    ? Math.floor(
        (available + GAP + PEEK) / ((available + GAP + PEEK) / COLS_MAX + GAP),
      )
    : COLS_MAX
  const cols = Math.max(1, Math.min(byWidth, byMax, COLS_MAX))
  const cell = (usable - (cols - 1) * GAP) / cols
  return { cols, cell: Math.max(COVER_MIN, cell) }
}

/**
 * 横向列表（在 Rail 滚动容器内）的可用整宽 = 滚动容器可视宽。
 * 滚动容器左右不再留内边距（见 Rail.css），故无需扣除。
 */
export function rowAvailable(scroller: HTMLElement | null): number {
  if (!scroller) return 0
  return scroller.clientWidth
}
