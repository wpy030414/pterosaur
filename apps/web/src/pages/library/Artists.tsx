import { useState } from 'react'
import { User } from 'lucide-react'
import { useLibrary } from '../../store/library.js'
import { useViewNavigate } from '../../hooks/useViewNavigate.js'
import { ArtistCard } from '../../components/EntityCards.js'
import { Empty } from '../../components/States.js'
import '../pages.css'

/**
 * 库 · 艺术家：收藏（星标）的艺人。
 *
 * 原「唱片盒」一页里的艺人分区，拆成独立子页（专辑见 `Albums.tsx`）。
 * 列表在**进入时冻结**（读一次 store 快照）：在页内取消收藏后卡片不立即消失（防误触），
 * 下次进入才刷新——沿用 ADR-017 的既有取舍。
 */
export function ArtistsPage() {
  const navigate = useViewNavigate()
  const [savedArtists] = useState(() => useLibrary.getState().savedArtists)

  return (
    <div className="library-page">
      <header className="library-page__header">
        <span className="library-page__label">库</span>
        <h1 className="library-page__title">艺术家</h1>
      </header>

      {savedArtists.length === 0 ? (
        <section className="section">
          <Empty
            text="还没有收藏的艺术家"
            icon={<User size={32} strokeWidth={1.5} />}
          />
        </section>
      ) : (
        <section className="section">
          <div className="card-grid">
            {savedArtists.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                onClick={() =>
                  navigate(
                    `/artist/${artist.source}/${artist.id}?name=${encodeURIComponent(artist.name)}`,
                  )
                }
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
