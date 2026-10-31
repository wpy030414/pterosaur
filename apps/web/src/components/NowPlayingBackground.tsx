import { useEffect, useState } from 'react'
import { canonicalNeteaseImage } from '@pterosaur/shared/image'
import { whenCoverReady } from '../lib/imageCache.js'

/** 淡入层落位等待时长：略长于 CSS 过渡，确保新图完全盖上后再卸下旧层。 */
export const BG_FADE_SETTLE_MS = 480

interface BgState {
  /** 底层常驻的背景（切歌期间保持旧图，避免整层空白）。 */
  stable: string | null
  /** 正在淡入盖上的新背景；等待落位后转正。 */
  incoming: string | null
}

/**
 * 沉浸页的动态模糊背景层（切歌防闪）。
 *
 * 稳定层（旧封面）常驻绘制，新封面**加载并解码完成后**才经淡入层盖上、淡完落位。
 * 此前用单层 `backgroundImage` 跟随 `current.cover` 同步替换——未缓存的封面在下载 +
 * 解码期间整层空白，透过 scrim 的 backdrop-filter 糊出身后页面（命中缓存则无感，
 * 正是「有概率」复现的来源）。见 ADR-041。
 */
export function NowPlayingBackground({
  coverUrl,
}: {
  /** 当前曲目封面的**大图**地址（已按场景降档）；空则维持现状。 */
  coverUrl: string | undefined
}) {
  const [bg, setBg] = useState<BgState>({ stable: null, incoming: null })

  useEffect(() => {
    if (!coverUrl) return
    let cancelled = false
    void whenCoverReady(coverUrl).then((ok) => {
      if (cancelled || !ok) return // 加载失败维持旧背景：稳定优先于空白
      setBg((prev) => {
        // 规范化后比较：旧持久化数据（轮换前的 host）与新鲜 API 数据是同一封面时不重复淡入
        const same = (a: string | null) =>
          a !== null &&
          canonicalNeteaseImage(a) === canonicalNeteaseImage(coverUrl)
        if (same(prev.stable) || same(prev.incoming)) return prev
        // 首张直接落位（进场动画本就有整体淡入），此后才走「旧图垫底 + 新图盖上」的交叉淡入
        return prev.stable === null
          ? { stable: coverUrl, incoming: null }
          : { stable: prev.stable, incoming: coverUrl }
      })
    })
    return () => {
      cancelled = true
    }
  }, [coverUrl])

  // 淡入完成 → 新图落位、卸载淡入层（收敛回单层，避免常驻多层全屏模糊的合成开销）
  useEffect(() => {
    if (!bg.incoming) return
    const t = setTimeout(
      () =>
        setBg((prev) =>
          prev.incoming ? { stable: prev.incoming, incoming: null } : prev,
        ),
      BG_FADE_SETTLE_MS,
    )
    return () => clearTimeout(t)
  }, [bg.incoming])

  return (
    <>
      <div
        className="nowplaying__bg"
        style={bg.stable ? { backgroundImage: `url(${bg.stable})` } : undefined}
        aria-hidden
      />
      {bg.incoming && (
        <div
          key={bg.incoming}
          className="nowplaying__bg nowplaying__bg-in"
          style={{ backgroundImage: `url(${bg.incoming})` }}
          aria-hidden
        />
      )}
    </>
  )
}
