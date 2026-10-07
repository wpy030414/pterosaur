import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useBackgroundUrl } from '../hooks/useBackgroundUrl.js'
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
import { formatTime, keyOf } from '@pterosaur/shared/types'
import type { Lyric } from '@pterosaur/shared/types'
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

  // 自定义应用背景：设置后，沉浸页隐藏封面、背景改用（高斯模糊的）自定义图。
  const background = useSettings((s) => s.background)
  const backgroundUrl = useBackgroundUrl()
  const useCustomBg = !!background && !!backgroundUrl

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

  // 自动滚动到当前行（居中）；首句未到时也保证第一行居中而非挤在顶部
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = listRef.current
    if (!el || !lyric?.timed || !lyric.lines.length) return
    // activeIndex 为 -1 表示播放位置尚未到达第一句：用第一行作为居中参照
    const targetIdx = activeIndex < 0 ? 0 : activeIndex
    const line = el.querySelector<HTMLElement>(`[data-idx="${targetIdx}"]`)
    if (!line) return

    const pad = Math.max(0, (el.clientHeight - line.clientHeight) / 2)
    el.style.paddingTop = `${pad}px`
    el.style.paddingBottom = `${pad}px`

    if (activeIndex < 0) {
      // 第一句还没到时静默滚到顶部——padding 已使第一行居中
      el.scrollTo({ top: 0, behavior: 'instant' })
    } else {
      const elRect = el.getBoundingClientRect()
      const lineRect = line.getBoundingClientRect()
      const delta =
        lineRect.top - elRect.top - (el.clientHeight - line.clientHeight) / 2
      el.scrollTo({ top: el.scrollTop + delta, behavior: 'smooth' })
    }
  }, [activeIndex, lyric])

  const mode = currentPlayMode(shuffle, repeat)
  const modeMeta = PLAY_MODE_META[mode]
  const ModeIcon = modeMeta.icon
  // 播放中且处于缓冲态：播放键显示加载动画
  const showBuffering = buffering && isPlaying

  if (!current) return null

  return (
    <div
      className={`nowplaying${exiting ? ' nowplaying--exit' : ''}${useCustomBg ? ' nowplaying--nocover' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="正在播放"
      aria-hidden={!open}
    >
      {/* 动态模糊背景：设了自定义背景则用它（无需防闪双层），否则用当前封面双层防闪 */}
      {useCustomBg ? (
        <div
          className="nowplaying__bg"
          style={{ backgroundImage: `url(${backgroundUrl})` }}
          aria-hidden
        />
      ) : (
        <>
          <div
            className="nowplaying__bg"
            style={
              bg.stable ? { backgroundImage: `url(${bg.stable})` } : undefined
            }
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
            <span>正在播放</span>
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
          {/* 左：封面（设了自定义背景时不展示） */}
          {!useCustomBg && (
            <div className="nowplaying__art">
              <Cover
                src={coverAt(current.cover, COVER_LARGE)}
                alt={current.title}
                radius="lg"
                className={`nowplaying__cover${isPlaying ? ' nowplaying__cover--playing' : ''}`}
              />
            </div>
          )}

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
