import { useCallback, useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Volume1,
  ListMusic,
  MoreHorizontal,
  Disc3,
  Loader2,
  Star,
} from 'lucide-react'
import { usePlayer, currentPlayMode } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { useQueuePanel } from '../store/ui.js'
import { startNowPlayingTransition } from '../lib/nowPlayingTransition.js'
import { seekTo } from '../hooks/audioElement.js'
import { formatTime, keyOf } from '@pterosaur/shared/types'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import { IconButton } from './IconButton.js'
import { Slider } from './Slider.js'
import { AddToPlaylistMenu } from './AddToPlaylistMenu.js'
import { PLAY_MODE_META } from './playMode.js'
import './PlayerBar.css'

export function PlayerBar() {
  const current = usePlayer((s) => s.current)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const repeat = usePlayer((s) => s.repeat)
  const shuffle = usePlayer((s) => s.shuffle)
  const buffering = usePlayer((s) => s.buffering)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const cyclePlayMode = usePlayer((s) => s.cyclePlayMode)
  // 订阅 expanded：展开态下需让本侧封面让出 `view-transition-name: np-cover`（见 PlayerBar.css）
  const expanded = usePlayer((s) => s.expanded)

  const favorites = useLibrary((s) => s.favorites)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const isFav = current
    ? favorites.some((t) => keyOf(t) === keyOf(current))
    : false

  const queueOpen = useQueuePanel((s) => s.queueOpen)
  const toggleQueue = useQueuePanel((s) => s.toggleQueue)

  // 拖拽进度：本地即时反馈，松手才真正 seek（避免频繁请求音频）
  // scrub 记录拖拽中的实时值，让左端读数跟着指尖走；同时记住所属曲目，换曲即失效
  const [scrub, setScrub] = useState<{ key: string; value: number } | null>(
    null,
  )
  const currentKey = current ? keyOf(current) : null
  const scrubValue =
    scrub && currentKey !== null && scrub.key === currentKey
      ? scrub.value
      : null

  const handleScrub = useCallback(
    (v: number) => {
      if (currentKey !== null) setScrub({ key: currentKey, value: v })
    },
    [currentKey],
  )

  const handleSeek = useCallback((v: number) => {
    seekTo(v)
    setScrub(null)
  }, [])

  const VolumeIcon =
    muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  // 播放中且处于缓冲态：播放键显示加载动画（暂停态不显示）
  const showBuffering = buffering && isPlaying
  const mode = currentPlayMode(shuffle, repeat)
  const modeMeta = PLAY_MODE_META[mode]
  const ModeIcon = modeMeta.icon

  return (
    <footer className="playerbar">
      {/* 悬浮玻璃岛：宽度由内容决定，不占满主内容区 */}
      <div className="playerbar__dock">
        {/* ---------- 左：控制区 ---------- */}
        <div className="playerbar__controls-left">
          {/* 播放模式：随机 / 循环合并为单一按钮，点击循环切换；靠专属图标区分状态 */}
          <IconButton
            label={`播放模式：${modeMeta.label}`}
            size="sm"
            onClick={cyclePlayMode}
          >
            <ModeIcon size={16} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="上一首"
            size="sm"
            onClick={prev}
            disabled={!current}
          >
            <SkipBack size={17} strokeWidth={2} fill="currentColor" />
          </IconButton>
          <IconButton
            label={showBuffering ? '缓冲中' : isPlaying ? '暂停' : '播放'}
            size="md"
            className="playerbar__play"
            onClick={toggle}
            disabled={!current}
            data-testid="play-toggle"
          >
            {showBuffering ? (
              <Loader2
                size={22}
                strokeWidth={2.2}
                className="spinner"
                data-testid="play-buffering"
              />
            ) : isPlaying ? (
              <Pause size={22} strokeWidth={2.2} fill="currentColor" />
            ) : (
              <Play size={22} strokeWidth={2.2} fill="currentColor" />
            )}
          </IconButton>
          <IconButton
            label="下一首"
            size="sm"
            onClick={next}
            disabled={!current}
          >
            <SkipForward size={17} strokeWidth={2} fill="currentColor" />
          </IconButton>
          <IconButton
            label={isFav ? '取消喜欢' : '喜欢'}
            size="sm"
            active={isFav}
            onClick={() => current && toggleFavorite(current)}
            disabled={!current}
          >
            <Star
              size={16}
              strokeWidth={2}
              fill={isFav ? 'currentColor' : 'none'}
            />
          </IconButton>
        </div>

        {/* ---------- 中：内容区（封面 / 歌名-艺术家 / 菜单 + 无读数进度条） ---------- */}
        <div className="playerbar__center">
          {current ? (
            <div className="playerbar__row">
              <button
                type="button"
                className={`playerbar__cover-btn${expanded ? ' playerbar__cover-btn--vt-hidden' : ''}`}
                onClick={() => startNowPlayingTransition(true)}
                aria-label="展开播放页"
              >
                <Cover
                  src={coverAt(current.cover, COVER_SMALL)}
                  alt={current.title}
                  seed={keyOf(current)}
                  radius="sm"
                  size={36}
                />
              </button>
              <div className="playerbar__meta">
                <div className="playerbar__title ellipsis">{current.title}</div>
                <div className="playerbar__artist ellipsis">
                  {current.artist}
                </div>
              </div>
              <div className="playerbar__actions">
                <AddToPlaylistMenu track={current} direction="up">
                  {({ onClick, open }) => (
                    <IconButton
                      label="加入歌单、下载"
                      size="sm"
                      active={open}
                      onClick={onClick}
                    >
                      <MoreHorizontal size={16} strokeWidth={2} />
                    </IconButton>
                  )}
                </AddToPlaylistMenu>
              </div>
            </div>
          ) : (
            <div className="playerbar__empty">
              <div className="playerbar__empty-cover">
                <Disc3 size={20} strokeWidth={1.5} />
              </div>
              <div className="playerbar__meta">
                <div className="playerbar__title">空空如也</div>
              </div>
            </div>
          )}
          {/*
            进度条：静默时只有一条 1.5px 细线；hover / 拖拽时转为强调色并加粗（长度不变），
            两端浮出读数、读数压在进度线**上方**，同时上排信息毛玻璃化（见 PlayerBar.css）。
            读数常驻 DOM、默认透明，以免出现/消失时推移进度线。
          */}
          <div className="playerbar__progress">
            <span className="playerbar__time playerbar__time--elapsed">
              {formatTime(scrubValue ?? position)}
            </span>
            <Slider
              value={position}
              max={duration || 0}
              onChange={handleScrub}
              onCommit={handleSeek}
              disabled={!current || !duration}
              ariaLabel="播放进度"
              size="sm"
            />
            <span className="playerbar__time playerbar__time--total">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* ---------- 右：副控制区（播放列表 / 音量） ---------- */}
        <div className="playerbar__right">
          <IconButton
            label={queueOpen ? '关闭播放队列' : '播放队列'}
            size="sm"
            active={queueOpen}
            onClick={toggleQueue}
          >
            <ListMusic size={16} strokeWidth={2} />
          </IconButton>
          <IconButton
            label={muted ? '取消静音' : '静音'}
            size="sm"
            onClick={toggleMute}
            disabled={!current}
          >
            <VolumeIcon size={16} strokeWidth={2} />
          </IconButton>
          <div className="playerbar__volume">
            <Slider
              value={muted ? 0 : volume}
              max={1}
              onChange={(v) => setVolume(v)}
              ariaLabel="音量"
              size="sm"
            />
          </div>
          {/* 移动端播放键（桌面端由左控制区提供） */}
          <IconButton
            label={showBuffering ? '缓冲中' : isPlaying ? '暂停' : '播放'}
            size="sm"
            className="playerbar__play playerbar__play-mobile"
            onClick={toggle}
            disabled={!current}
            data-testid="play-toggle-mobile"
          >
            {showBuffering ? (
              <Loader2
                size={20}
                strokeWidth={2.2}
                className="spinner"
                data-testid="play-buffering-mobile"
              />
            ) : isPlaying ? (
              <Pause size={20} strokeWidth={2.2} fill="currentColor" />
            ) : (
              <Play size={20} strokeWidth={2.2} fill="currentColor" />
            )}
          </IconButton>
          {current && (
            <IconButton
              className="playerbar__fav-mobile"
              label={isFav ? '取消喜欢' : '喜欢'}
              size="sm"
              active={isFav}
              onClick={() => toggleFavorite(current)}
            >
              <Star
                size={17}
                strokeWidth={2}
                fill={isFav ? 'currentColor' : 'none'}
              />
            </IconButton>
          )}
        </div>
      </div>
    </footer>
  )
}
