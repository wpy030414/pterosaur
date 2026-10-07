import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Heart,
  ListMusic,
  Loader2,
} from 'lucide-react'
import { usePlayer, currentPlayMode } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { useQueuePanel } from '../store/ui.js'
import { useSettings } from '../store/settings.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { seekTo } from '../hooks/audioElement.js'
import { api } from '../api/client.js'
import { getCachedLyric, putCachedLyric } from '../lib/lyricCache.js'
import { whenCoverReady } from '../lib/imageCache.js'
import {
  canonicalNeteaseImage,
  coverAt,
  COVER_LARGE,
} from '@pterosaur/shared/image'
import { startNowPlayingTransition } from '../lib/nowPlayingTransition.js'
import { formatTime, keyOf, formatQuality } from '@pterosaur/shared/types'
import type { AudioQuality, Lyric } from '@pterosaur/shared/types'
import { Cover } from './Cover.js'
import { IconButton } from './IconButton.js'
import { Slider } from './Slider.js'
import { PLAY_MODE_META } from './playMode.js'
import './NowPlaying.css'

interface NowPlayingProps {
  /** 是否处于展开态（退出动画期间为 false）。 */
  open: boolean
  /** 是否正在播放退出动画。 */
  exiting: boolean
}

/** 背景双层状态：stable 为常驻绘制层，incoming 为正在淡入、淡完落位即卸载的层。 */
type BgState = { stable: string | null; incoming: string | null }

/**
 * 背景淡入动画（`--dur-slow` = 400ms）后的落位时限。用定时器而非 animationend 兜底：
 * reduced-motion 下动画时长被压到 0.01ms，事件时机不可靠（与 usePresence 同款处理）。
 */
const BG_FADE_SETTLE_MS = 480

/** 移动端断点：与 `NowPlaying.css` 的 `@media (max-width: 860px)` 保持一致。 */
const MOBILE_QUERY = '(max-width: 860px)'

/**
 * 全屏播放页（Apple Music「正在播放」）。
 *
 * 左侧封面（带动态模糊背景），右侧上部同步歌词、下部播放控制。
 * 常驻挂载，由 `open`/`exiting` 驱动进入 / 退出动画；Esc 关闭。
 */
export function NowPlaying({ open, exiting }: NowPlayingProps) {
  const current = usePlayer((s) => s.current)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const repeat = usePlayer((s) => s.repeat)
  const shuffle = usePlayer((s) => s.shuffle)
  const buffering = usePlayer((s) => s.buffering)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const cyclePlayMode = usePlayer((s) => s.cyclePlayMode)
  const setExpanded = usePlayer((s) => s.setExpanded)
  const navigate = useViewNavigate()

  /** 跳转到专辑 / 艺人页：先收起沉浸页，否则整屏浮层会盖住目标页面。 */
  const openEntity = (to: string) => {
    setExpanded(false)
    navigate(to)
  }

  const favorites = useLibrary((s) => s.favorites)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const isFav = current
    ? favorites.some((t) => keyOf(t) === keyOf(current))
    : false
  const toggleQueue = useQueuePanel((s) => s.toggleQueue)
  const queueOpen = useQueuePanel((s) => s.queueOpen)

  const [lyric, setLyric] = useState<Lyric | null>(null)
  const [lyricLoading, setLyricLoading] = useState(false)

  /*
   * 切歌防闪背景：稳定层（旧封面）常驻绘制，新封面**加载并解码完成后**才经淡入层盖上、
   * 淡完落位。此前单层 `backgroundImage` 跟随 `current.cover` 同步替换——未缓存的封面在
   * 下载 + 解码期间整层空白，透过 scrim 的 backdrop-filter 糊出身后页面（命中缓存则无感，
   * 正是「有概率」复现的来源）。
   */
  const [bg, setBg] = useState<BgState>({ stable: null, incoming: null })

  const coverUrl = current ? coverAt(current.cover, COVER_LARGE) : undefined
  useEffect(() => {
    if (!coverUrl) return
    let cancelled = false
    whenCoverReady(coverUrl).then((ok) => {
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

  // 拉取歌词
  useEffect(() => {
    let cancelled = false
    if (!current) {
      setLyric(null)
      return
    }
    // 命中预载缓存：直接显示，无「歌词加载中」停留
    const cached = getCachedLyric(current)
    if (cached) {
      setLyric(cached)
      setLyricLoading(false)
      return
    }
    setLyricLoading(true)
    setLyric(null)
    api
      .lyric(current.source, current.id)
      .then((l) => {
        if (cancelled) return
        putCachedLyric(current, l)
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
  }, [current])

  // 音质 chip：反映服务端**实际**解析到的档位（含降级），仅在展开时拉取（见 ADR-041）。
  const level = useSettings((s) => s.level)
  const [quality, setQuality] = useState<AudioQuality | null>(null)
  useEffect(() => {
    if (!open || !current) {
      setQuality(null)
      return
    }
    let cancelled = false
    api
      .quality(current.source, current.id, level)
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
  }, [open, current, level])

  // 移动端「专注歌词」：点封面收起（缩小封面 + 隐藏歌名 / 歌手，腾给歌词），再点复原。
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const [lyricFocused, setLyricFocused] = useState(false)
  // 切歌 / 收起沉浸页时复位为初始态
  useEffect(() => {
    setLyricFocused(false)
  }, [current, open])

  // 当前高亮行下标
  const activeIndex = useMemo(() => {
    if (!lyric?.timed || !lyric.lines.length) return -1
    let idx = -1
    for (let i = 0; i < lyric.lines.length; i++) {
      if (lyric.lines[i].time <= position) idx = i
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
  }, [current])

  const mode = currentPlayMode(shuffle, repeat)
  const modeMeta = PLAY_MODE_META[mode]
  const ModeIcon = modeMeta.icon
  // 播放中且处于缓冲态：播放键显示加载动画
  const showBuffering = buffering && isPlaying

  // 顶部音频流参数（如 `FLAC · 1411Kbps · 44.1kHz`）；未解析到 / 该源不支持时为空，不渲染。
  const streamInfo = quality ? formatQuality(quality) : ''

  if (!current) return null

  return (
    <div
      className={`nowplaying${exiting ? ' nowplaying--exit' : ''}${lyricFocused ? ' nowplaying--focus' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="正在播放"
      aria-hidden={!open}
    >
      {/* 动态模糊背景：当前封面双层防闪（切歌时新封面淡入盖上旧封面）。
          自定义应用背景**不**作用于沉浸页（见 ADR-041）。 */}
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
      <div
        className="nowplaying__scrim"
        onClick={() => startNowPlayingTransition(false)}
        aria-hidden
      />

      <div className="nowplaying__inner">
        <header className="nowplaying__header">
          <IconButton
            label="收起播放页"
            size="md"
            onClick={() => startNowPlayingTransition(false)}
          >
            <ChevronDown size={24} strokeWidth={2.2} />
          </IconButton>
          <div className="nowplaying__header-title">
            {/* 顶部不再有「正在播放」标语：这里直接如实展示当前音频流参数（见 ADR-041）。 */}
            {streamInfo && (
              <span
                className="nowplaying__stream"
                data-testid="nowplaying-stream"
              >
                {streamInfo}
              </span>
            )}
            <strong className="ellipsis">
              {current.albumId && current.album ? (
                <button
                  type="button"
                  className="nowplaying__link"
                  onClick={() =>
                    openEntity(`/album/${current.source}/${current.albumId}`)
                  }
                >
                  {current.album}
                </button>
              ) : (
                current.album || '单曲'
              )}
            </strong>
          </div>
          <IconButton
            label={isFav ? '取消喜欢' : '喜欢'}
            size="md"
            active={isFav}
            onClick={() => toggleFavorite(current)}
          >
            <Heart
              size={20}
              strokeWidth={2}
              fill={isFav ? 'currentColor' : 'none'}
            />
          </IconButton>
        </header>

        <div className="nowplaying__body">
          {/* 左：封面。移动端可点按切换「专注歌词」（缩小封面、隐藏歌名 / 歌手，腾给歌词）。 */}
          <div
            className={`nowplaying__art${isMobile ? ' nowplaying__art--tap' : ''}`}
            onClick={isMobile ? () => setLyricFocused((v) => !v) : undefined}
            role={isMobile ? 'button' : undefined}
            tabIndex={isMobile ? 0 : undefined}
            aria-label={
              isMobile
                ? lyricFocused
                  ? '退出专注歌词'
                  : '进入专注歌词'
                : undefined
            }
            onKeyDown={
              isMobile
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setLyricFocused((v) => !v)
                    }
                  }
                : undefined
            }
          >
            <Cover
              src={coverAt(current.cover, COVER_LARGE)}
              alt={current.title}
              radius="lg"
              className={`nowplaying__cover${isPlaying ? ' nowplaying__cover--playing' : ''}`}
            />
          </div>

          {/* 右：歌词（上）+ 控制（下） */}
          <div className="nowplaying__panel">
            <div className="nowplaying__info">
              <h1 className="nowplaying__title ellipsis">{current.title}</h1>
              <p className="nowplaying__artist ellipsis">
                {current.artistRefs?.length
                  ? current.artistRefs.map((a, i) => (
                      <span key={`${a.id}-${i}`}>
                        {i > 0 && ' / '}
                        <button
                          type="button"
                          className="nowplaying__link"
                          onClick={() =>
                            openEntity(
                              `/artist/${current.source}/${a.id}?name=${encodeURIComponent(a.name)}`,
                            )
                          }
                        >
                          {a.name}
                        </button>
                      </span>
                    ))
                  : current.artist}
              </p>
            </div>

            {/* 歌词 */}
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

            {/* 进度 */}
            <div className="nowplaying__progress">
              <Slider
                value={position}
                max={duration || 0}
                onChange={() => {}}
                onCommit={(v) => seekTo(v)}
                disabled={!duration}
                ariaLabel="播放进度"
                size="md"
              />
              <div className="nowplaying__times">
                <span>{formatTime(position)}</span>
                <span>-{formatTime(Math.max(0, duration - position))}</span>
              </div>
            </div>

            {/* 控制：语义与底部播放栏一致（模式合并按钮 + 队列按钮） */}
            <div className="nowplaying__controls">
              <IconButton
                label={`播放模式：${modeMeta.label}`}
                size="md"
                onClick={cyclePlayMode}
              >
                <ModeIcon size={20} strokeWidth={2} />
              </IconButton>
              <IconButton label="上一首" size="lg" onClick={prev}>
                <SkipBack size={26} strokeWidth={2} fill="currentColor" />
              </IconButton>
              <IconButton
                label={showBuffering ? '缓冲中' : isPlaying ? '暂停' : '播放'}
                size="lg"
                primary
                onClick={toggle}
                className="nowplaying__play"
              >
                {showBuffering ? (
                  <Loader2
                    size={28}
                    strokeWidth={2.2}
                    className="spinner"
                    data-testid="play-buffering-np"
                  />
                ) : isPlaying ? (
                  <Pause size={28} strokeWidth={2.2} fill="currentColor" />
                ) : (
                  <Play size={28} strokeWidth={2.2} fill="currentColor" />
                )}
              </IconButton>
              <IconButton label="下一首" size="lg" onClick={next}>
                <SkipForward size={26} strokeWidth={2} fill="currentColor" />
              </IconButton>
              <IconButton
                label={queueOpen ? '关闭播放队列' : '播放队列'}
                size="md"
                active={queueOpen}
                onClick={toggleQueue}
              >
                <ListMusic size={20} strokeWidth={2} />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
