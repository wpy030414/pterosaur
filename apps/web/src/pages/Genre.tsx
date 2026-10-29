import { useParams } from 'react-router-dom'
import { Tag } from 'lucide-react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeMusicSource } from '../store/auth.js'
import type { Playlist } from '@pterosaur/shared/types'
import { DEFAULT_SOURCE, keyOf } from '@pterosaur/shared/types'
import { PlaylistCard } from '../components/PlaylistCard.js'
import { Loading, ErrorState, Empty } from '../components/States.js'
import './pages.css'

/**
 * 流派页：某个歌单分类（如「华语」「流行」）下的歌单网格。
 *
 * 入口来自搜索页落地页的分类快捷入口（见 `pages/Search.tsx`）。分类名直接进 URL
 * （`/genre/:name`），天然支持刷新、分享与浏览器前进后退。
 */
export function GenrePage() {
  const { name = '' } = useParams()
  const navigate = useViewNavigate()
  const status = useAuth((s) => s.status)
  const source = activeMusicSource(status) ?? DEFAULT_SOURCE

  const list = useAsync<Playlist[]>(
    () => api.playlists(source, 60, name),
    [source, name],
    [],
  )

  return (
    <div className="browse">
      <header className="browse__header">
        <span className="browse__label">流派</span>
        <h1 className="browse__title">{name}</h1>
      </header>

      <section className="section">
        {list.loading ? (
          <Loading text="加载歌单…" />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.data?.length ? (
          <div className="card-grid">
            {list.data.map((p) => (
              <PlaylistCard
                key={keyOf(p)}
                playlist={p}
                onClick={() => navigate(`/playlist/${p.source}/${p.id}`)}
              />
            ))}
          </div>
        ) : (
          <Empty
            text={`「${name}」下暂时没有歌单`}
            icon={<Tag size={32} strokeWidth={1.5} />}
          />
        )}
      </section>
    </div>
  )
}
