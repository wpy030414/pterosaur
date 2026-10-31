import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Lyric, Track } from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { seekTo } from '../hooks/audioElement.js'
import { getCachedLyric, putCachedLyric } from '../lib/lyricCache.js'

interface LyricPanelProps {
  /** 当前曲目（歌词按其源 + id 拉取并缓存）。 */
  track: Track | null
  /** 当前播放位置（秒），用于高亮行与自动滚动。 */
  position: number
}

/**
 * 同步歌词面板：拉取（命中预载缓存则即时显示）、高亮当前行、自动居中滚动。
 *
 * 歌词与播放位置解耦于沉浸页其它部分——只有这里订阅 `position`，切歌时其余区域
 * 不必随进度重渲染。
 */
export function LyricPanel({ track, position }: LyricPanelProps) {
  const [lyric, setLyric] = useState<Lyric | null>(null)
  const [lyricLoading, setLyricLoading] = useState(false)

  // 拉取歌词
  useEffect(() => {
    let cancelled = false
    if (!track) {
      setLyric(null)
      return
    }
    // 命中预载缓存：直接显示，无「歌词加载中」停留
    const cached = getCachedLyric(track)
    if (cached) {
      setLyric(cached)
      setLyricLoading(false)
      return
    }
    setLyricLoading(true)
    setLyric(null)
    api
      .lyric(track.source, track.id)
      .then((l) => {
        if (cancelled) return
        putCachedLyric(track, l)
        setLyric(l)
      })
      .catch(() => {
        if (!cancelled) setLyric({ lines: [], timed: false })
      })
      .finally(() => {
        if (!cancelled) setLyricLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [track])

  // 当前高亮行下标
  const activeIndex = useMemo(() => {
    if (!lyric?.timed || !lyric.lines.length) return -1
    let idx = -1
    for (let i = 0; i < lyric.lines.length; i++) {
      const line = lyric.lines[i]
      if (line && line.time <= position) idx = i
      else break
    }
    return idx
  }, [lyric, position])

  // 自动滚动到当前行（居中）；首句未到时也保证第一行居中而非挤在顶部。
  // 提取为回调，供「当前行变化」与「容器高度变化」两处复用。
  const listRef = useRef<HTMLDivElement | null>(null)
  const centerActiveLine = useCallback(
    (animate: boolean) => {
      const el = listRef.current
      if (!el || !lyric?.timed || !lyric.lines.length) return
      // activeIndex 为 -1 表示播放位置尚未到达第一句：用第一行作为居中参照
      const targetIdx = activeIndex < 0 ? 0 : activeIndex
      const line = el.querySelector<HTMLElement>(`[data-idx="${targetIdx}"]`)
      if (!line) return

      // 首 / 末行居中的上下留白：写成 CSS 变量、由 `.nowplaying__lyrics` 的 `::before/::after`
      // 撑起，而**不是**直接改容器的 `padding`。改 padding 等于每次换行都动这个滚动容器自身的
      // 盒模型，WebKit 下会触发它重新测高、把下方控制区顶出视口（见 ADR-041）。
      const pad = Math.max(0, (el.clientHeight - line.clientHeight) / 2)
      el.style.setProperty('--np-lyric-pad', `${pad}px`)

      if (activeIndex < 0) {
        // 第一句还没到时静默滚到顶部——留白已使第一行居中
        el.scrollTo({ top: 0, behavior: 'instant' })
      } else {
        const elRect = el.getBoundingClientRect()
        const lineRect = line.getBoundingClientRect()
        const delta =
          lineRect.top - elRect.top - (el.clientHeight - line.clientHeight) / 2
        el.scrollTo({
          top: el.scrollTop + delta,
          behavior: animate ? 'smooth' : 'instant',
        })
      }
    },
    [activeIndex, lyric],
  )

  useEffect(() => {
    centerActiveLine(true)
  }, [centerActiveLine])

  // 歌词区高度变化时也要立即重居中，否则点封面「专注歌词」（容器变高）后当前行会偏，
  // 非得等到下一句才归位。ResizeObserver 观察的是容器盒尺寸（不受留白伪元素影响，无回环）。
  const centerRef = useRef(centerActiveLine)
  useEffect(() => {
    centerRef.current = centerActiveLine
  }, [centerActiveLine])
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => centerRef.current(false))
    ro.observe(el)
    return () => ro.disconnect()
  }, [track])

  return (
    <div className="nowplaying__lyrics" ref={listRef}>
      {lyricLoading ? (
        <div className="nowplaying__lyrics-empty">歌词加载中…</div>
      ) : !lyric || !lyric.lines.length ? (
        <div className="nowplaying__lyrics-empty">暂无歌词</div>
      ) : lyric.timed ? (
        lyric.lines.map((l, i) => (
          <p
            key={`${l.time}-${i}`}
            data-idx={i}
            className={`lyric-line${i === activeIndex ? ' lyric-line--active' : ''}${
              i < activeIndex ? ' lyric-line--past' : ''
            }`}
            onClick={() => seekTo(l.time)}
            role="button"
            tabIndex={-1}
          >
            <span>{l.text || '♪'}</span>
            {l.translation && (
              <span className="lyric-line__trans">{l.translation}</span>
            )}
          </p>
        ))
      ) : (
        lyric.lines.map((l, i) => (
          <p key={i} className="lyric-line lyric-line--plain">
            {l.text}
          </p>
        ))
      )}
    </div>
  )
}
