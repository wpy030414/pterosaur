import { useEffect, useState } from 'react'

/**
 * 订阅一个媒体查询的命中状态（随视口变化实时更新）。
 *
 * 无 `matchMedia` 的环境（SSR / 旧测试桩）恒返回 `false`。
 * 与 CSS 的同名断点需保持一致（如 `NowPlaying` 的 `(max-width: 860px)`）。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (!window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange() // query 变化时同步校正一次
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
