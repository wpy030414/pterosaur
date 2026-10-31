import { useEffect, useRef, useState } from 'react'
import { Plus, Check, Download, Loader2, HardDriveDownload } from 'lucide-react'
import type { Track } from '@pterosaur/shared/types'
import { keyOf } from '@pterosaur/shared/types'
import { useLibrary } from '../store/library.js'
import { useSettings } from '../store/settings.js'
import { downloadTrack } from '../lib/download.js'
import { useOffline } from '../store/offline.js'
import './AddToPlaylistMenu.css'

interface AddToPlaylistMenuProps {
  track: Track
  /** 菜单展开方向：默认向下；位于屏幕底部（如播放条）时用 `up` 向上弹出。 */
  direction?: 'down' | 'up'
  /** 触发按钮的渲染（由调用方决定外观），点击后打开菜单 */
  children: (props: {
    onClick: (e: React.MouseEvent) => void
    open: boolean
  }) => React.ReactNode
}

/**
 * 「添加到歌单」下拉菜单：保存离线 / 下载到本地 + 加入/移出已有本地歌单。
 *
 * 点击某歌单一次为加入，再点一次为从中移除（切换态）。
 * 采用受控浮层 + 点击外部关闭；菜单锚定在触发按钮附近。
 */
export function AddToPlaylistMenu({
  track,
  direction = 'down',
  children,
}: AddToPlaylistMenuProps) {
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const saveTrackOffline = useOffline((s) => s.saveTrack)
  const saveMessage = useOffline((s) => s.error ?? s.lastMessage)
  const playlists = useLibrary((s) => s.playlists)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const removeFromPlaylist = useLibrary((s) => s.removeFromPlaylist)
  const level = useSettings((s) => s.level)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  /**
   * 保存离线：写进应用自己的 IndexedDB，断网也能播；与「下载到本地」（写到磁盘文件）
   * 是两件事，故并列而不合并（见 ADR-060）。
   */
  const handleSaveOffline = async () => {
    if (downloading) return
    setDownloadError(null)
    await saveTrackOffline(track, level)
  }

  const handleDownload = async () => {
    if (downloading) return
    setDownloadError(null)
    setDownloading(true)
    try {
      await downloadTrack(track, level)
      setOpen(false)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : '下载失败')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={`atp${direction === 'up' ? ' atp--up' : ''}`} ref={wrapRef}>
      {children({
        onClick: (e) => {
          e.stopPropagation()
          setDownloadError(null)
          setOpen((v) => !v)
        },
        open,
      })}
      {open && (
        <div
          className="atp__menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="atp__item"
            onClick={handleSaveOffline}
            disabled={downloading}
            data-testid="save-offline"
          >
            <HardDriveDownload size={16} />
            <span>保存离线</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="atp__item"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 size={16} className="atp__spin" />
            ) : (
              <Download size={16} />
            )}
            <span>{downloading ? '正在下载…' : '下载到本地'}</span>
          </button>

          {(downloadError || saveMessage) && (
            <div className="atp__error">{downloadError ?? saveMessage}</div>
          )}

          {playlists.length > 0 && (
            <>
              <div className="atp__sep" />
              <div className="atp__sub">
                {playlists.map((p) => {
                  const inList = p.tracks.some((t) => keyOf(t) === keyOf(track))
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      className="atp__item"
                      onClick={() => {
                        // 点一次加入，再点一次移除；不关闭菜单，便于连续调整多个歌单
                        if (inList) removeFromPlaylist(p.id, track)
                        else addToPlaylist(p.id, track)
                      }}
                    >
                      {inList ? (
                        <Check size={16} className="atp__check" />
                      ) : (
                        <Plus size={16} />
                      )}
                      <span className="ellipsis">{p.name}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {playlists.length === 0 && (
            <div className="atp__empty">
              还没有歌单，可在侧边栏「资料库」处新建
            </div>
          )}
        </div>
      )}
    </div>
  )
}
