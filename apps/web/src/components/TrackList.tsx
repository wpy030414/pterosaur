import { Play, Pause, Heart, MoreHorizontal, Clock } from 'lucide-react'
import type { Track } from '@pterosaur/shared/types'
import { formatTime, keyOf } from '@pterosaur/shared/types'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import { IconButton } from './IconButton.js'
import { AddToPlaylistMenu } from './AddToPlaylistMenu.js'
import { expandGroups } from '../lib/cassette.js'
import './TrackList.css'

interface TrackListProps {
  tracks: Track[]
  /** 是否显示表头（序号/标题/专辑/时长） */
  showHeader?: boolean
  /** 是否显示序号列 */
  showIndex?: boolean
  /** 是否显示专辑列（磁带等「无专辑」语境的列表可关掉，标题列随之加宽） */
  showAlbum?: boolean
  /** 空状态文案 */
  emptyText?: string
  /** 附加类名 */
  className?: string
  /** 行点击的自定义处理（不传则默认「以本列表为队列播放」，并展开 B 站分P）。 */
  onPlayRow?: (track: Track, index: number) => void
}

/**
 * 曲目列表（Apple Music 风格表格行）。
 *
 * - 单击行：以该列表为队列播放；
 * - 播放中且为当前曲目：显示跳动音柱 + 高亮；
 * - 行内艺人名 / 专辑名可点击，跳转到对应的艺人页 / 专辑页（缺 id 时降级为纯文本）；
 * - 行内提供喜欢、添加到歌单操作。
 */
export function TrackList({
  tracks,
  showHeader = true,
  showIndex = true,
  showAlbum = true,
  emptyText = '暂无曲目',
  className,
  onPlayRow,
}: TrackListProps) {
  const queue = usePlayer((s) => s.queue)
  const current = usePlayer((s) => s.current)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const playTracks = usePlayer((s) => s.playTracks)
  const toggle = usePlayer((s) => s.toggle)

  const favorites = useLibrary((s) => s.favorites)
  const toggleFavorite = useLibrary((s) => s.toggleFavorite)
  const navigate = useViewNavigate()

  // 链接点击不应触发行播放：阻止冒泡 + 阻止键盘事件冒泡到行
  const openEntity = (e: React.SyntheticEvent, to: string) => {
    e.stopPropagation()
    navigate(to)
  }
  const stopKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  }

  if (!tracks.length) {
    return (
      <div className="track-list__empty">
        <Clock size={28} strokeWidth={1.5} />
        <span>{emptyText}</span>
      </div>
    )
  }

  /** 以某列表为队列播放（含「点当前曲目即切换播放/暂停」的判定）。 */
  const playList = (list: Track[], index: number) => {
    const target = list[index]
    if (!target) return
    if (
      current &&
      keyOf(target) === keyOf(current) &&
      isSameQueue(queue, list)
    ) {
      toggle()
      return
    }
    if (isSameQueue(queue, list)) {
      const i = queue.findIndex((t) => keyOf(t) === keyOf(target))
      if (i >= 0) {
        usePlayer.getState().playIndex(i)
        return
      }
    }
    playTracks(list, index)
  }

  const handleRowPlay = (index: number) => {
    const track = tracks[index]
    if (onPlayRow) {
      onPlayRow(track, index)
      return
    }
    // 仅当列表含「一对多」条目（如 B 站分P）时才需异步展开；否则同步走既有路径。
    const hasParts = tracks.some(
      (t) => t.source === 'bilibili' && !t.id.includes(':'),
    )
    if (!hasParts) {
      playList(tracks, index)
      return
    }
    void (async () => {
      const groups = await expandGroups(tracks)
      const expanded = groups.flat()
      const startIndex = groups
        .slice(0, index)
        .reduce((n, g) => n + g.length, 0)
      playList(expanded, startIndex)
    })()
  }

  return (
    <div
      className={`track-list${showAlbum ? '' : ' track-list--no-album'}${className ? ` ${className}` : ''}`}
      role="list"
    >
      {showHeader && (
        <div className="track-list__head">
          {showIndex && <span className="col-index">#</span>}
          <span className="col-title">标题</span>
          {showAlbum && <span className="col-album">专辑</span>}
          <span className="col-duration">
            <Clock size={14} strokeWidth={2} />
          </span>
          <span className="col-actions" />
        </div>
      )}

      {tracks.map((t, i) => {
        // 磁带（B 站）的「一对多」：队列里是分P（`bvid:cid`），列表行却是整视频（`bvid`）——
        // 故再以 bvid 前缀匹配，保证播放某分P 时对应视频行同样高亮。
        const isCurrent = current
          ? keyOf(current) === keyOf(t) ||
            (current.source === 'bilibili' &&
              t.source === 'bilibili' &&
              current.id.split(':')[0] === t.id)
          : false
        const isCurrentPlaying = isCurrent && isPlaying
        const isFav = favorites.some((f) => keyOf(f) === keyOf(t))
        return (
          <div
            key={`${keyOf(t)}-${i}`}
            className={`track-row${isCurrent ? ' track-row--current' : ''}`}
            role="listitem"
            onClick={() => handleRowPlay(i)}
            tabIndex={0}
            onKeyDown={(e) => {
              // 仅在行本身获得焦点时响应键盘，避免行内链接触发播放
              if (e.key === 'Enter' && e.target === e.currentTarget)
                handleRowPlay(i)
            }}
          >
            {showIndex && (
              <span className="col-index">
                {isCurrentPlaying ? (
                  <span className="eq-bars" aria-hidden>
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                ) : isCurrent ? (
                  <Pause
                    size={13}
                    fill="currentColor"
                    className="col-index__pause"
                  />
                ) : (
                  <>
                    <span className="col-index__num">{i + 1}</span>
                    <Play
                      size={13}
                      fill="currentColor"
                      className="col-index__play"
                    />
                  </>
                )}
              </span>
            )}

            <span className="col-title">
              <Cover
                src={coverAt(t.cover, COVER_SMALL)}
                alt={t.title}
                radius="sm"
                size={40}
              />
              <span className="col-title__text">
                <span className="col-title__name ellipsis">{t.title}</span>
                <span className="col-title__artist ellipsis">
                  {t.artistRefs?.length
                    ? t.artistRefs.map((a, ai) => (
                        <span key={`${a.id}-${ai}`}>
                          {ai > 0 && ' / '}
                          <button
                            type="button"
                            className="track-link"
                            onClick={(e) =>
                              openEntity(
                                e,
                                `/artist/${t.source}/${a.id}?name=${encodeURIComponent(a.name)}`,
                              )
                            }
                            onKeyDown={stopKey}
                          >
                            {a.name}
                          </button>
                        </span>
                      ))
                    : t.artist}
                </span>
              </span>
            </span>

            {showAlbum && (
              <span className="col-album ellipsis">
                {t.albumId && t.album ? (
                  <button
                    type="button"
                    className="track-link"
                    onClick={(e) =>
                      openEntity(e, `/album/${t.source}/${t.albumId}`)
                    }
                    onKeyDown={stopKey}
                  >
                    {t.album}
                  </button>
                ) : (
                  t.album
                )}
              </span>
            )}

            <span className="col-duration">
              {t.duration ? formatTime(t.duration) : '--:--'}
            </span>

            <span className="col-actions" onClick={(e) => e.stopPropagation()}>
              <IconButton
                label={isFav ? '取消喜欢' : '喜欢'}
                size="sm"
                active={isFav}
                className="row-action"
                onClick={() => toggleFavorite(t)}
              >
                <Heart
                  size={16}
                  strokeWidth={2}
                  fill={isFav ? 'currentColor' : 'none'}
                />
              </IconButton>
              <AddToPlaylistMenu track={t}>
                {({ onClick }) => (
                  <IconButton
                    label="添加到歌单"
                    size="sm"
                    className="row-action"
                    onClick={onClick}
                  >
                    <MoreHorizontal size={17} strokeWidth={2} />
                  </IconButton>
                )}
              </AddToPlaylistMenu>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 判断两个队列是否为同一批曲目（顺序与身份键一致）。 */
function isSameQueue(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++)
    if (keyOf(a[i]) !== keyOf(b[i])) return false
  return true
}
