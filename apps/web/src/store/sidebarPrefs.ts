import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/** 侧边栏里可折叠的分组。 */
export type SidebarGroupKey = 'library' | 'playlists'

/**
 * 侧边栏分组的展开 / 收起偏好。
 *
 * 与 `store/ui.ts` 分开**单独持久化**：`ui` 里装的是队列面板、新建歌单弹窗这类
 * 高频、一次性的临时状态，把它们写进 localStorage 只会制造噪音；这里只有两个布尔，
 * 且是用户明确的显示偏好，刷新后应当保留。
 */
interface SidebarPrefsState {
  groups: Record<SidebarGroupKey, boolean>
  toggleGroup: (key: SidebarGroupKey) => void
  setGroup: (key: SidebarGroupKey, open: boolean) => void
}

const DEFAULT_GROUPS: Record<SidebarGroupKey, boolean> = {
  library: true,
  playlists: true,
}

export const useSidebarPrefs = create<SidebarPrefsState>()(
  persist(
    (set) => ({
      groups: DEFAULT_GROUPS,
      toggleGroup: (key) =>
        set((s) => ({ groups: { ...s.groups, [key]: !s.groups[key] } })),
      setGroup: (key, open) =>
        set((s) => ({ groups: { ...s.groups, [key]: open } })),
    }),
    {
      name: 'pterosaur-sidebar-prefs',
      storage: createJSONStorage(() => localStorage),
      // 旧版本没有该键 / 载荷被清空时，回落到默认全展开
      merge: (persisted, current) => {
        const p = persisted as Partial<SidebarPrefsState> | undefined
        return {
          ...current,
          groups: { ...DEFAULT_GROUPS, ...p?.groups },
        }
      },
    },
  ),
)

/** 读取某个分组的展开态（默认展开）。 */
export function useSidebarGroupOpen(key: SidebarGroupKey): boolean {
  return useSidebarPrefs((s) => s.groups[key] ?? true)
}
