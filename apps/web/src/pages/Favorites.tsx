import { Play, Shuffle, Star } from 'lucide-react'
import { useLibrary } from '../store/library.js'
import { usePlayer } from '../store/player.js'
import { TrackList } from '../components/TrackList.js'
import { IconButton } from '../components/IconButton.js'
import { RipButton } from '../components/RipButton.js'
import { Empty } from '../components/States.js'
import { useRip } from '../store/rip.js'
import { useSettings } from '../store/settings.js'
import { isRipping, runRip } from '../lib/rip.js'
import { ripDialog } from '../store/ui.js'

/**
 * 我喜欢的音乐。展示收藏曲目，支持顺序 / 随机播放。
 */
export function FavoritesPage() {
  const favorites = useLibrary((s) => s.favorites)
  const playTracks = usePlayer((s) => s.playTracks)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const level = useSettings((s) => s.level)

  // 翻录进度：从全局 store 认领「我喜欢的音乐」那份（切走再回自动恢复）
  const ripKey = 'favorites'
  const ripJob = useRip((s) => s.job)
  const myRip = ripJob?.key === ripKey ? ripJob : null

  const handlePlay = (shuffle = false) => {
    if (!favorites.length) return
    if (shuffle && !usePlayer.getState().shuffle) toggleShuffle()
    playTracks(
      favorites,
      shuffle ? Math.floor(Math.random() * favorites.length) : 0,
    )
  }

  const handleDownloadPlaylist = async () => {
    if (!favorites.length || isRipping()) return
    const mixed = new Set(favorites.map((t) => t.source)).size > 1
    const choice = await ripDialog({
      name: '我喜欢的音乐',
      trackCount: favorites.length,
      totalDuration: favorites.reduce((sum, t) => sum + (t.duration || 0), 0),
      mixedSources: mixed,
    })
    if (!choice) return
    await runRip({
      key: ripKey,
      tracks: favorites,
      meta: {
        kind: 'favorites',
        name: '我喜欢的音乐',
        source: mixed ? undefined : favorites[0]?.source,
      },
      level,
      choice,
    })
  }

  return (
    <div className="detail detail--playlist">
      <header className="detail__hero">
        <div className="fav-cover" aria-hidden>
          <Star fill="currentColor" strokeWidth={0} />
        </div>
        <div className="detail__info">
          <h1 className="detail__name">我喜欢的音乐</h1>
        </div>
      </header>

      <div className="detail__actions">
        <button
          type="button"
          className="detail__play"
          onClick={() => handlePlay(false)}
          disabled={!favorites.length}
        >
          <Play size={18} fill="currentColor" strokeWidth={0} />
          播放
        </button>
        <IconButton
          label="随机播放"
          size="lg"
          onClick={() => handlePlay(true)}
          disabled={!favorites.length}
        >
          <Shuffle size={20} strokeWidth={2} />
        </IconButton>
        <RipButton
          progress={myRip}
          disabled={
            !favorites.length || (ripJob !== null && ripJob.key !== ripKey)
          }
          onClick={handleDownloadPlaylist}
        />
      </div>

      <div className="detail__list">
        {favorites.length === 0 ? (
          <Empty text="还没有喜欢的音乐" icon={<Star size={32} strokeWidth={1.5} />} />
        ) : (
          <TrackList tracks={favorites} />
        )}
      </div>
    </div>
  )
}
