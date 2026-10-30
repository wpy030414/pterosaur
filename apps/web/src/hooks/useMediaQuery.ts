import { useEffect, useState } from 'react'

/**
 * 全站唯一的移动端查询（权威边界 768px，见 `styles/tokens.css` 的 `--bp-mobile`）。
 * 与 CSS 的 `@media (max-width: 768px)` 必须一致；JS 侧需要门控布局时一律引用它，
 * 不要就地另写宽度字面量。
 */
export const MOBILE_QUERY = '(max-width: 768px)'

/**
 * 订阅一个媒体查询的命中状态（随视口变化实时更新）。
 *
 * 无 `matchMedia` 的环境（SSR / 旧测试桩）恒返回 `false`。
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
