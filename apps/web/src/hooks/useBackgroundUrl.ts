import { useEffect, useState } from 'react'
import { useSettings } from '../store/settings.js'
import { currentBackgroundUrl, getBackgroundUrl } from '../lib/background.js'

/**
 * 当前自定义背景的 object URL（无背景 / 未就绪时返回 `null`）。
 *
 * 媒体本体在 IndexedDB，读取是异步的：先取同步缓存作首帧，再异步载入并刷新。
 * 背景配置变更（换图 / 清除）会使 effect 重跑、重新载入。
 */
export function useBackgroundUrl(): string | null {
  const bg = useSettings((s) => s.background)
  const [url, setUrl] = useState<string | null>(() =>
    bg ? currentBackgroundUrl() : null,
  )

  useEffect(() => {
    if (!bg) {
      setUrl(null)
      return
    }
    let alive = true
    void getBackgroundUrl().then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [bg])

  return url
}
