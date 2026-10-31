import { useEffect, useState } from 'react'
import {
  formatQuality,
  type AudioQuality,
  type Track,
} from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { useSettings } from '../store/settings.js'

/**
 * 顶部音频流参数 chip（如 `FLAC · 1411Kbps · 44.1kHz`）。
 *
 * 反映服务端**实际**解析到的档位（含降级，见 ADR-041），仅在沉浸页展开时拉取：
 * 该源未实现 / 解析失败时不渲染，绝不阻塞播放。
 */
export function QualityChip({
  track,
  visible,
}: {
  track: { source: Track['source']; id: string } | null
  /** 沉浸页是否展开：收起时不请求。 */
  visible: boolean
}) {
  const level = useSettings((s) => s.level)
  const [quality, setQuality] = useState<AudioQuality | null>(null)

  useEffect(() => {
    if (!visible || !track) {
      setQuality(null)
      return
    }
    let cancelled = false
    api
      .quality(track.source, track.id, level)
      .then((q) => {
        if (!cancelled) setQuality(q)
      })
      .catch(() => {
        // 接口不可用（如该源未实现 501）或解析失败：不显示 chip，绝不阻塞播放
        if (!cancelled) setQuality(null)
      })
    return () => {
      cancelled = true
    }
  }, [visible, track, level])

  if (!quality) return null
  return (
    <span className="nowplaying__stream" data-testid="nowplaying-stream">
      {formatQuality(quality)}
    </span>
  )
}
