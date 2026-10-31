import { useEffect, useRef, useState } from 'react'
import { dominantColor } from '../lib/dominantColor.js'

/** 撤掉 `--art-color` 前的等待时长：让底色先落回 `--bg`，避免切换页面时取色时序错乱。 */
export const ART_COLOR_SETTLE_MS = 720

/**
 * 依图片代表色给 `html` 写主题色变量（仿 `useAccentFromBackground` 的「JS 覆写 CSS 变量」）。
 *
 * 取到色后给 `<html>` 打 `data-art-color`，CSS 据此把 `.app-main` 与侧栏的底色切到代表色
 * （见 app.css）；页面卸载时移除，底色落回 `--bg`。底色变化不做补间过渡，直接切换。
 *
 * - 取色异步：图未就绪、加载失败或被跨域拦下时**不覆盖**，页面保持默认底色，不闪不跳；
 * - `url` 变化时先撤旧色再取新色，避免上一张封面的颜色残留到下一张。
 */
export function useArtColor(url: string | undefined): void {
  const [color, setColor] = useState<string | null>(null)
  // 迟滞：快速连续切换详情页时，只有最后一次取色结果允许落地
  const seq = useRef(0)

  useEffect(() => {
    setColor(null)
    if (!url) return
    const id = ++seq.current
    let alive = true
    void dominantColor(url).then((c) => {
      if (!alive || id !== seq.current || !c) return
      setColor(c)
    })
    return () => {
      alive = false
    }
  }, [url])

  useEffect(() => {
    const root = document.documentElement
    if (!color) return
    root.style.setProperty('--art-color', color)
    root.dataset.artColor = 'on'
    return () => {
      delete root.dataset.artColor
      // 等底色落回 --bg 之后再撤掉变量，避免取色时序错乱。
      // 期间若新页已重新取色，变量会被改写为同值，这里的清理是空操作。
      window.setTimeout(() => {
        if (!root.dataset.artColor) root.style.removeProperty('--art-color')
      }, ART_COLOR_SETTLE_MS)
    }
  }, [color])
}
