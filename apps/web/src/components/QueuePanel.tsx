import { X, Trash2, Play } from 'lucide-react'
import { keyOf } from '@pterosaur/shared/types'
import { playerCommands } from '../store/player.js'
import { usePlayerQueue } from '../store/playerQueue.js'
import { useQueuePanel } from '../store/ui.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import { IconButton } from './IconButton.js'
import './QueuePanel.css'

/**
 * 右侧滑出的播放队列面板。展示当前队列，可点击跳转、删除、清空。
 */
export function QueuePanel() {
  const open = useQueuePanel((s) => s.queueOpen)
  const setOpen = useQueuePanel((s) => s.setQueueOpen)
  const queue = usePlayerQueue((s) => s.queue)
  const index = usePlayerQueue((s) => s.index)
  const playIndex = playerCommands.playIndex
  const removeAt = playerCommands.removeAt
  const clearQueue = playerCommands.clearQueue

  return (
    <>
      {open && (
        <div
          className="queue-scrim"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={`queue-panel${open ? ' queue-panel--open' : ''}`}
        aria-hidden={!open}
        aria-label="播放队列"
      >
        <div className="queue-panel__head">
          <h2>播放队列</h2>
          {queue.length > 0 && (
            <button
              type="button"
              className="queue-panel__clear"
              onClick={clearQueue}
            >
              <Trash2 size={14} /> 清空
            </button>
          )}
        </div>

        <div className="queue-panel__count">{queue.length} 首曲目</div>

        <div className="queue-panel__list">
          {queue.length === 0 ? (
            <div className="queue-panel__empty">队列为空，去挑几首歌吧</div>
          ) : (
            queue.map((t, i) => {
              const active = i === index
              return (
                <div
                  key={`${keyOf(t)}-${i}`}
                  className={`queue-item${active ? ' queue-item--active' : ''}`}
                  onClick={() => playIndex(i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      playIndex(i)
                    }
                  }}
                >
                  <div className="queue-item__index">
                    {active ? <Play size={13} fill="currentColor" /> : i + 1}
                  </div>
                  <Cover
                    src={coverAt(t.cover, COVER_SMALL)}
                    alt={t.title}
                    radius="sm"
                    size={40}
                  />
                  <div className="queue-item__meta">
                    <div className="queue-item__title ellipsis">{t.title}</div>
                    <div className="queue-item__artist ellipsis">
                      {t.artist}
                    </div>
                  </div>
                  <IconButton
                    label="从队列移除"
                    size="sm"
                    className="queue-item__remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeAt(i)
                    }}
                  >
                    <X size={15} />
                  </IconButton>
                </div>
              )
            })
          )}
        </div>
      </aside>
    </>
  )
}
