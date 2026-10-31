import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ListMusic,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Star,
} from 'lucide-react'
import { ARTIST_SEPARATOR, formatTime, keyOf } from '@pterosaur/shared/types'
import { COVER_LARGE, coverAt } from '@pterosaur/shared/image'
import { playerCommands, currentPlayMode } from '../store/player.js'
import { usePlaybackSession } from '../store/playbackSession.js'
import { usePlayerQueue } from '../store/playerQueue.js'
import { usePlayerUi } from '../store/playerUi.js'
import { useLibrary } from '../store/library.js'
import { useQueuePanel } from '../store/ui.js'
import { useMediaQuery, MOBILE_QUERY } from '../hooks/useMediaQuery.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { seekTo } from '../hooks/audioElement.js'
import { startNowPlayingTransition } from '../lib/nowPlayingTransition.js'
import { Cover } from './Cover.js'
import { IconButton } from './IconButton.js'
import { Slider } from './Slider.js'
import { PLAY_MODE_META } from './playMode.js'
import { LyricPanel } from './LyricPanel.js'
import { NowPlayingBackground } from './NowPlayingBackground.js'
import { QualityChip } from './QualityChip.js'
import './NowPlaying.css'

export interface NowPlayingProps {
  /** 是否处于展开态（退出动画期间仍为 true）。 */
  open: boolean
  /** 是否正在播放退出动画（此时不能响应关闭）。 */
  exiting: boolean
}

/**
 * 全屏播放页（Apple Music「正在播放」）。
 *
 * 左侧封面（带动态模糊背景），右侧上部同步歌词、下部播放控制。
 * 常驻挂载，由 `open`/`exiting` 驱动进入 / 退出动画；Esc 关闭。
 *
 * 结构上拆为三个自带状态的自洽块：
 * - {@link NowPlayingBackground}：双层模糊背景（切歌防闪）
 * - {@link LyricPanel}：唯一订阅 `position` 的区域（歌词高亮与居中滚动）
 * - {@link QualityChip}：顶部实际音频流参数
 * 本组件只负责布局与「曲目元信息 / 封面 / 控制」。
 */
export function NowPlaying({ open, exiting }: NowPlayingProps) {
  const current = usePlaybackSession((s) => s.current)
  const isPlaying = usePlaybackSession((s) => s.isPlaying)
  const position = usePlaybackSession((s) => s.position)
  const duration = usePlaybackSession((s) => s.duration)
  const buffering = usePlaybackSession((s) => s.buffering)
  const repeat = usePlayerQueue((s) => s.repeat)
  const shuffle = usePlayerQueue((s) => s.shuffle)
  const toggle = playerCommands.toggle
  const next = playerCommands.next
  const prev = playerCommands.prev
  const cyclePlayMode = playerCommands.cyclePlayMode
  const setExpanded = usePlayerUi((s) => s.setExpanded)
  const navigate = useViewNavigate()

  /** 跳转到专辑 / 艺术家页：先收起沉浸页，否则整屏浮层会盖住目标页面。 */
  const openEntity = (to: string) => {
    setExpanded(false)
    void navigate(to)
  }

  const favorites = useLibrary((s) => s.favorites)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const isFav = current
    ? favorites.some((t) => keyOf(t) === keyOf(current))
    : false
  const toggleQueue = useQueuePanel((s) => s.toggleQueue)
  const queueOpen = useQueuePanel((s) => s.queueOpen)

  // 移动端「专注歌词」：点封面收起（缩小封面 + 隐藏歌名 / 艺术家，腾给歌词），再点复原。
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const [lyricFocused, setLyricFocused] = useState(false)
  // 切歌 / 收起沉浸页时复位为初始态
  useEffect(() => {
    setLyricFocused(false)
  }, [current, open])

  const mode = currentPlayMode(shuffle, repeat)
  const modeMeta = PLAY_MODE_META[mode]
  const ModeIcon = modeMeta.icon
  // 播放中且处于缓冲态：播放键显示加载动画
  const showBuffering = buffering && isPlaying

  if (!current) return null

  const coverUrl = coverAt(current.cover, COVER_LARGE)

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
      <NowPlayingBackground coverUrl={coverUrl || undefined} />
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
            <QualityChip track={current} visible={open} />
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
            <Star
              size={20}
              strokeWidth={2}
              fill={isFav ? 'currentColor' : 'none'}
            />
          </IconButton>
        </header>

        <div className="nowplaying__body">
          {/* 左：封面。移动端可点按切换「专注歌词」（缩小封面、隐藏歌名 / 艺术家，腾给歌词）。 */}
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
              src={coverUrl}
              alt={current.title}
              seed={keyOf(current)}
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
                        {i > 0 && ARTIST_SEPARATOR}
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

            <LyricPanel track={current} position={position} />

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
