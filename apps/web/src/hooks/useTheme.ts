import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      // 默认深色（不再跟随系统）：明暗由设置弹窗里的「外观」显式选择
      mode: 'dark',
      setMode: (mode) => set({ mode }),
    }),
    { name: 'pterosaur-theme', storage: createJSONStorage(() => localStorage) },
  ),
)

/** 将主题模式应用到 `<html data-theme>`，system 模式下移除该属性交由媒体查询决定。 */
export function useApplyTheme(): void {
  const mode = useTheme((s) => s.mode)

  // 用 useLayoutEffect 而非 useEffect：主题转场的新快照在 flushSync 返回后**同步**拍摄，
  // useEffect 要到 paint 之后才跑，会把旧主题拍进新快照、令圆形揭示失效。
  useLayoutEffect(() => {
    const root = document.documentElement
    if (mode === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', mode)
    }
  }, [mode])
}
