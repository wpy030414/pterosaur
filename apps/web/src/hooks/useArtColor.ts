import { useEffect, useRef, useState } from 'react'
import { dominantColor } from '../lib/dominantColor.js'

/**
 * 依图片代表色给 `html` 写主题色变量（仿 `useAccentFromBackground` 的「JS 覆写 CSS 变量」）。
 *
 * 取到色后给 `<html>` 打 `data-art-color`，CSS 据此把 `.app-main` 与侧栏的底色切到代表色
 * （见 app.css）；页面卸载时同一帧移除，底色立即落回 `--bg`。底色变化不做补间过渡，直接切换。
 * 不留「延迟撤变量」的等待：那段时间里新页面已挂载却仍停在旧代表色上，切页体感发滞。
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
      // 属性与变量一起撤：详情页 → 详情页时由上一页清理、下一页取色后重新写入；
      // 其间新页面短暂用默认底色（与「取色完成前先用默认底色」一致），不会闪。
      delete root.dataset.artColor
      root.style.removeProperty('--art-color')
    }
  }, [color])
}
