import { useEffect, useRef, useState } from 'react'
import { isCoverReady, markCoverReady } from '../lib/imageCache.js'
import { coverArtFor } from '../lib/coverArt.js'
import './Cover.css'

interface CoverProps {
  src?: string
  alt: string
  /** 圆角风格：sm 用于列表行，md 用于卡片，lg 用于播放页 */
  radius?: 'sm' | 'md' | 'lg' | 'none'
  /** 是否为圆形（艺人头像等） */
  rounded?: boolean
  className?: string
  size?: number | string
  /**
   * 兜底图案的种子（一般传 `keyOf(entity)`，即 `source:id`）。
   * 缺省时退回 `src`（封面 URL）——同一实体的封面 URL 是稳定的，故同样确定。
   */
  seed?: string
  draggable?: boolean
}

/**
 * 封面图。带加载占位、失败兜底（显示唱片图标）。
 */
export function Cover({
  src,
  alt,
  radius = 'md',
  rounded,
  className,
  size,
  draggable,
  seed,
}: CoverProps) {
  // 已预取 / 已展示过的封面：首帧即视为就绪、直接显色，供 View Transition 同步快照拍到成图
  const [loaded, setLoaded] = useState(() => isCoverReady(src))
  const [failed, setFailed] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // 已缓存的图片（如预载后重挂载）不会触发 onLoad；挂载 / src 变化时按 DOM 现状同步校正，
  // 消除占位闪。`complete` 为 true 表示下载已结束（含 error），需再看 naturalWidth 区分成败。
  useEffect(() => {
    const el = imgRef.current
    const done = !!el && el.complete
    const ok = done && el.naturalWidth > 0
    if (ok) markCoverReady(src)
    setLoaded(ok)
    setFailed(done && el.naturalWidth === 0)
  }, [src])

  const style: React.CSSProperties = {}
  if (size !== undefined) {
    style.width = typeof size === 'number' ? `${size}px` : size
    style.height = style.width
  }

  // 无图可显示时，把派生出的渐变**直接铺在最外层**（它本来就是 100% 尺寸），
  // 内层只负责水印——不依赖子元素撑满，避免任何尺寸塌陷导致底色不可见。
  const showFallback = !src || failed
  const fallbackArt = showFallback ? coverArtFor(seed ?? src ?? alt) : undefined

  return (
    <div
      className={[
        'cover',
        `cover--${rounded ? 'circle' : radius}`,
        loaded && !failed ? 'cover--loaded' : '',
        showFallback ? 'cover--fallback' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        fallbackArt ? { ...style, background: fallbackArt.background } : style
      }
    >
      {src && !failed ? (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          draggable={draggable ?? false}
          /* 不带 Referer：部分图床（如 B 站 hdslb）对异域 Referer 直接 403（防盗链） */
          referrerPolicy="no-referrer"
          onLoad={() => {
            markCoverReady(src)
            setLoaded(true)
          }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="cover__brand" aria-hidden>
          Pt
        </span>
      )}
    </div>
  )
}
