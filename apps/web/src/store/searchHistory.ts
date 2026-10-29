import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/** 最近搜索词的保留上限（搜索落地页最多展示这么多条）。 */
export const SEARCH_HISTORY_MAX = 10

/**
 * 最近搜索关键词（本地持久化）。
 *
 * 与 `store/ui.ts` 分开单独持久化：`ui` 装的是弹窗开合这类一次性的临时状态，
 * 而「搜过什么」是用户可见、刷新后应当还在的记录。与 `sidebarPrefs` 同理。
 *
 * - 入栈即**置顶**：重复搜索同一个词只会把它提到最前，而不是产生重复项。
 * - 超出 {@link SEARCH_HISTORY_MAX} 时淘汰最旧的一条。
 * - 不记源：关键词本身是跨源通用的，渠道差异由搜索页当前的活动源决定。
 */
interface SearchHistoryState {
  /** 最近搜索词，下标 0 为最新。 */
  terms: string[]
  /** 记录一次搜索（调用方自行 trim；空串忽略）。 */
  push: (term: string) => void
  remove: (term: string) => void
  clear: () => void
}

export const useSearchHistory = create<SearchHistoryState>()(
  persist(
    (set) => ({
      terms: [],
      push: (term) =>
        set((s) => {
          const t = term.trim()
          if (!t) return s
          return {
            terms: [t, ...s.terms.filter((x) => x !== t)].slice(
              0,
              SEARCH_HISTORY_MAX,
            ),
          }
        }),
      remove: (term) =>
        set((s) => ({ terms: s.terms.filter((t) => t !== term) })),
      clear: () => set({ terms: [] }),
    }),
    {
      name: 'pterosaur-search-history',
      storage: createJSONStorage(() => localStorage),
      // 旧版本 / 载荷被清空 / 手改坏了存储时，回落到空列表（并截断到上限）
      merge: (persisted, current) => {
        const p = persisted as Partial<SearchHistoryState> | undefined
        const terms = Array.isArray(p?.terms)
          ? p.terms.filter((t): t is string => typeof t === 'string')
          : []
        return { ...current, terms: terms.slice(0, SEARCH_HISTORY_MAX) }
      },
    },
  ),
)
