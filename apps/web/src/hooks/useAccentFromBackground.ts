import { useLayoutEffect } from 'react'
import { useSettings } from '../store/settings.js'
import { deriveAccent } from '../lib/accent.js'

/** 被覆写的四个强调色变量。 */
const VARS = [
  '--accent',
  '--accent-hover',
  '--accent-press',
  '--accent-soft',
] as const

/**
 * 依自定义背景取出的主题色，覆写 `--accent*`（替代默认红）。清除背景则回落 `:root` 的红色。
 *
 * 仿 `useSourceTheme` 的「JS 覆写 CSS 变量」做法：直接写 `document.documentElement.style`。
 * 取色结果随 `settings.background.accent` 持久化，故刷新后无需重新取色、无闪变。
 */
export function useAccentFromBackground(): void {
  const accent = useSettings((s) => s.background?.accent ?? null)

  useLayoutEffect(() => {
    const root = document.documentElement
    if (!accent) {
      for (const v of VARS) root.style.removeProperty(v)
      return
    }
    const a = deriveAccent(accent)
    root.style.setProperty('--accent', a.base)
    root.style.setProperty('--accent-hover', a.hover)
    root.style.setProperty('--accent-press', a.press)
    root.style.setProperty('--accent-soft', a.soft)
    return () => {
      for (const v of VARS) root.style.removeProperty(v)
    }
  }, [accent])
}
