import { useLayoutEffect } from 'react'
import { useSettings } from '../store/settings.js'
import { useBackgroundUrl } from '../hooks/useBackgroundUrl.js'
import './AppBackground.css'

/**
 * 自定义应用背景层：铺在顶栏 / 侧边栏 / 主内容区之下（**不含底部播放条**）。
 *
 * 作为 `.app-shell` 内的绝对定位层（`z-index: -1`，配合 `.app-shell` 的 `isolation: isolate`），
 * 主体区域本身保持毛玻璃 / 半透明，背景从其后透出。未设置背景时不渲染。
 *
 * 同时在 `<html>` 上打 `data-has-bg`：供 CSS 仅在**有背景时**把三大区域调得更透明
 * （见 `styles/app.css`），不影响默认外观。
 */
export function AppBackground() {
  const bg = useSettings((s) => s.background)
  const url = useBackgroundUrl()
  const active = !!bg && !!url

  useLayoutEffect(() => {
    const root = document.documentElement
    if (active) root.dataset.hasBg = 'on'
    else delete root.dataset.hasBg
    return () => {
      delete root.dataset.hasBg
    }
  }, [active])

  if (!active) return null
  return (
    <div className="app-bg" aria-hidden>
      {bg.kind === 'video' ? (
        <video
          className="app-bg__media"
          src={url}
          autoPlay
          loop
          muted
          playsInline
        />
      ) : (
        <img className="app-bg__media" src={url} alt="" />
      )}
    </div>
  )
}
