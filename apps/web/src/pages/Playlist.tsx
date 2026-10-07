import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Play, Shuffle, Trash2, Heart } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { usePlayer } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { confirmDialog } from '../store/ui.js'
import type { Playlist, Track } from '@pterosaur/shared/types'
import {
  DEFAULT_SOURCE,
  isMusicSource,
  isCassetteSource,
  type MusicSource,
} from '@pterosaur/shared/types'
import { TrackList } from '../components/TrackList.js'
import { coverAt, COVER_LARGE } from '@pterosaur/shared/image'
import { Cover } from '../components/Cover.js'
import { CassetteShell } from '../components/CassetteShell.js'
import { IconButton } from '../components/IconButton.js'
import { RipButton } from '../components/RipButton.js'
import { Loading, ErrorState } from '../components/States.js'
import { useRip } from '../store/rip.js'
import { useSettings } from '../store/settings.js'
import { isRipping, runRip } from '../lib/rip.js'

/** 格式化播放量。 */
function fmtCount(n?: number): string {
  if (!n) return ''
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿次播放`
  if (n >= 1e4) return `${Math.round(n / 1e4)} 万次播放`
  return `${n} 次播放`
}

/**
 * 歌单详情页。
 *
 * 同时支持三种集合：
 * - 本地自建歌单（id 以 `pl-` 开头，来自 library store）；
 * - 网易云歌单（数字 id，通过 API 拉取）；
 * - **磁带**（`source` 为磁带渠道，如 B 站——`Playlist` 即磁带，见 ADR-044）：套用「4:3 封面 +
 *   磁带边框」与「磁带」类型标签，其余（播放 / 随机 / 收藏到资料库 / 翻录 / 分P 列表）全部复用。
 */
export function PlaylistPage() {
  const params = useParams()
  const source: MusicSource = isMusicSource(params.source)
    ? params.source
    : DEFAULT_SOURCE
  const id = params.id ?? ''
  const navigate = useViewNavigate()
  const isLocal = id.startsWith('pl-')
  const isCassette = isCassetteSource(source)

  const playlists = useLibrary((s) => s.playlists)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)
  const renamePlaylist = useLibrary((s) => s.renamePlaylist)
  const savedPlaylists = useLibrary((s) => s.savedPlaylists)
  const toggleSavePlaylist = useLibrary((s) => s.toggleSavePlaylist)
  const playTracks = usePlayer((s) => s.playTracks)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const level = useSettings((s) => s.level)

  // 本地歌单标题的内联重命名
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement | null>(null)

  // 翻录进度：从全局 store 认领属于本歌单的那份（切走再回自动恢复）
  const ripKey = `playlist:${source}:${id}`
  const ripJob = useRip((s) => s.job)
  const myRip =
    ripJob?.key === ripKey
      ? { current: ripJob.current, total: ripJob.total }
      : null

  // 本地歌单：直接从 store 取
  const local = useMemo(
    () => (isLocal ? playlists.find((p) => p.id === id) : undefined),
    [isLocal, playlists, id],
  )

  // 远程歌单：通过 API 拉取（带缓存键，参数切换时命中缓存可免于加载态，转场更顺滑）
  const remote = useAsync<{ playlist: Playlist; tracks: Track[] }>(
    () =>
      isLocal
        ? Promise.resolve({
            playlist: { source: DEFAULT_SOURCE, id, name: '', cover: '' },
            tracks: [],
          })
        : api.playlist(source, id),
    [source, id, isLocal],
    null,
    isLocal ? undefined : `playlist:${source}:${id}`,
  )

  const playlist: Playlist | undefined = isLocal
    ? {
        source: DEFAULT_SOURCE,
        id,
        name: local?.name ?? '歌单',
        cover: local?.tracks[0]?.cover ?? '',
        trackCount: local?.tracks.length ?? 0,
      }
    : remote.data?.playlist
  const tracks = isLocal ? (local?.tracks ?? []) : (remote.data?.tracks ?? [])
  const loading = !isLocal && remote.loading
  const error = !isLocal
    ? remote.error
    : isLocal && !local
      ? '歌单不存在'
      : null

  // 在线歌单是否已收藏到资料库（仅保存引用，按路由 id 判断）
  const isSaved =
    !isLocal && savedPlaylists.some((p) => p.source === source && p.id === id)

  const handlePlay = (shuffle = false) => {
    if (!tracks.length) return
    if (shuffle && !usePlayer.getState().shuffle) toggleShuffle()
    playTracks(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0)
  }

  // 切换歌单时退出重命名态
  useEffect(() => {
    setRenaming(false)
  }, [id])

  // 进入重命名时聚焦并全选
  useEffect(() => {
    if (renaming) {
      const el = renameRef.current
      el?.focus()
      el?.select()
    }
  }, [renaming])

  const startRename = () => {
    setRenameValue(local?.name ?? '')
    setRenaming(true)
  }

  const commitRename = () => {
    const next = renameValue.trim()
    if (next && next !== local?.name) renamePlaylist(id, next)
    setRenaming(false)
  }

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: '删除歌单？',
      message: `「${playlist?.name ?? ''}」将被删除，此操作无法撤销。`,
      confirmText: '删除',
      danger: true,
    })
    if (ok) {
      deletePlaylist(id)
      navigate('/')
    }
  }

  const handleDownloadPlaylist = async () => {
    if (!tracks.length || isRipping()) return
    const dur = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const durStr = dur > 0 ? `，总时长约 ${Math.round(dur / 60)} 分钟` : ''
    const ok = await confirmDialog({
      title: '翻录歌单？',
      message: `将打包下载 ${tracks.length} 首曲目${durStr}。`,
      confirmText: '开始翻录',
    })
    if (!ok) return
    await runRip({
      key: ripKey,
      tracks,
      zipName: playlist?.name ?? '歌单',
      level,
    })
  }

  if (loading) {
    return (
      <div className="detail">
        <Loading text="加载歌单…" />
      </div>
    )
  }

  if (error || !playlist) {
    return (
      <div className="detail">
        <ErrorState
          message={error ?? '歌单不存在'}
          onRetry={isLocal ? undefined : remote.reload}
        />
      </div>
    )
  }

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)

  return (
    <div className="detail">
      <header className="detail__hero">
        {isCassette ? (
          <div className="detail__art--cassette">
            <CassetteShell>
              <Cover
                src={coverAt(playlist.cover, COVER_LARGE)}
                alt={playlist.name}
                radius="sm"
                className="card__cover"
              />
            </CassetteShell>
          </div>
        ) : (
          <Cover
            src={coverAt(playlist.cover, COVER_LARGE)}
            alt={playlist.name}
            radius="lg"
            className="detail__cover"
          />
        )}
        <div className="detail__info">
          <span className="detail__type">
            {isLocal ? '本地歌单' : isCassette ? '磁带' : '歌单'}
          </span>
          {isLocal && renaming ? (
            <input
              ref={renameRef}
              className="detail__name detail__name--editing"
              value={renameValue}
              maxLength={60}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') setRenaming(false)
              }}
              aria-label="重命名歌单"
            />
          ) : isLocal ? (
            <h1
              className="detail__name detail__name--editable"
              onClick={startRename}
              title="点击重命名"
            >
              {playlist.name}
            </h1>
          ) : (
            <h1 className="detail__name">{playlist.name}</h1>
          )}
          {!isLocal && playlist.description && (
            <p className="detail__desc">{playlist.description}</p>
          )}
          <p className="detail__meta">
            {playlist.creator && <span>{playlist.creator} · </span>}
            <span>{tracks.length} 首</span>
            {totalDuration > 0 && (
              <span> · 约 {Math.round(totalDuration / 60)} 分钟</span>
            )}
            {!isLocal && playlist.playCount
              ? ` · ${fmtCount(playlist.playCount)}`
              : ''}
          </p>
        </div>
      </header>

      <div className="detail__actions">
        <button
          type="button"
          className="detail__play"
          onClick={() => handlePlay(false)}
          disabled={!tracks.length}
        >
          <Play size={18} fill="currentColor" strokeWidth={0} />
          播放
        </button>
        <IconButton
          label="随机播放"
          size="lg"
          onClick={() => handlePlay(true)}
          disabled={!tracks.length}
        >
          <Shuffle size={20} strokeWidth={2} />
        </IconButton>
        {!isLocal && (
          <IconButton
            label={isSaved ? '取消收藏' : '收藏到资料库'}
            size="lg"
            active={isSaved}
            onClick={() => toggleSavePlaylist(playlist)}
          >
            <Heart
              size={20}
              strokeWidth={2}
              fill={isSaved ? 'currentColor' : 'none'}
            />
          </IconButton>
        )}
        {isLocal && (
          <IconButton label="删除歌单" size="lg" onClick={handleDelete}>
            <Trash2 size={19} strokeWidth={2} />
          </IconButton>
        )}
        <RipButton
          progress={myRip}
          disabled={
            !tracks.length || (ripJob !== null && ripJob.key !== ripKey)
          }
          onClick={handleDownloadPlaylist}
        />
      </div>

      <div className="detail__list">
        <TrackList
          tracks={tracks}
          emptyText={isCassette ? '这盘磁带还没有曲目' : '这个歌单还没有曲目'}
          showAlbum={!isCassette}
        />
      </div>
    </div>
  )
}
