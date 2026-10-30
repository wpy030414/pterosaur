import { useState } from 'react'
import { Disc3 } from 'lucide-react'
import { useLibrary } from '../../store/library.js'
import { useViewNavigate } from '../../hooks/useViewNavigate.js'
import { AlbumCard } from '../../components/EntityCards.js'
import { Empty } from '../../components/States.js'
import '../pages.css'

/**
 * 库 · 专辑：收藏的专辑。
 *
 * 原「唱片盒」一页里的专辑分区，拆成独立子页（艺术家见 `Artists.tsx`）。
 * 与艺术家页一致：列表在**进入时冻结**（读一次 store 快照），页内取消收藏不即时移除。
 */
export function AlbumsPage() {
  const navigate = useViewNavigate()
  const [savedAlbums] = useState(() => useLibrary.getState().savedAlbums)

  return (
    <div className="library-page">
      <header className="library-page__header">
        <span className="library-page__label">库</span>
        <h1 className="library-page__title">专辑</h1>
      </header>

      {savedAlbums.length === 0 ? (
        <section className="section">
          <Empty
            text="还没有收藏的专辑"
            icon={<Disc3 size={32} strokeWidth={1.5} />}
          />
        </section>
      ) : (
        <section className="section">
          <div className="card-grid">
            {savedAlbums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={() => navigate(`/album/${album.source}/${album.id}`)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
