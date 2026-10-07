import { useEffect, useMemo, useRef } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar.js'
import { Topbar } from './components/Topbar.js'
import { PlayerBar } from './components/PlayerBar.js'
import { AppBackground } from './components/AppBackground.js'
import { NowPlaying } from './components/NowPlaying.js'
import { QueuePanel } from './components/QueuePanel.js'
import { LoginModal } from './components/LoginModal.js'
import { CreatePlaylistModal } from './components/CreatePlaylistModal.js'
import { ConfirmDialog } from './components/ConfirmDialog.js'
import { SettingsDialog } from './components/SettingsDialog.js'
import { PlayErrorToast } from './components/PlayErrorToast.js'
import { Home } from './pages/Home.js'
import { Browse } from './pages/Browse.js'
import { Radio } from './pages/Radio.js'
import { SearchPage } from './pages/Search.js'
import { PlaylistPage } from './pages/Playlist.js'
import { ArtistPage } from './pages/Artist.js'
import { AlbumPage } from './pages/Album.js'
import { CratePage } from './pages/Crate.js'
import { FavoritesPage } from './pages/Favorites.js'
import { RecentPage } from './pages/Recent.js'
import { useAudioEngine } from './hooks/useAudioEngine.js'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js'
import { useLibrarySync } from './hooks/useLibrarySync.js'
import { useNowPlayingPrefetch } from './hooks/useNowPlayingPrefetch.js'
import { usePlaylistPrefetch } from './hooks/usePlaylistPrefetch.js'
import { useContentScrollRestoration } from './hooks/useContentScrollRestoration.js'
import { useSourceTheme } from './hooks/useSourceTheme.js'
import { useApplyTheme } from './hooks/useTheme.js'
import { useAccentFromBackground } from './hooks/useAccentFromBackground.js'
import { usePresence } from './hooks/usePresence.js'
import { supportsViewTransition } from './lib/viewTransition.js'
import { audioEl } from './hooks/audioElement.js'
import { useAuth } from './store/auth.js'
import { usePlayer } from './store/player.js'
import './styles/app.css'

/** 沉浸播放页退出动画时长（与 NowPlaying.css 的 np-exit 时长保持一致）。 */
const NP_EXIT_MS = 420

/**
 * 沉浸播放页宿主。
 *
 * 由**它**单独订阅 `expanded` 并驱动 presence —— 若把这层订阅留在 `App`，则每次开合都会
 * 让整棵应用树（含当前路由页）重渲染，移动端点击封面进入时有可感卡顿。
 */
function NowPlayingLayer() {
  // VT 能力在组件内自算（supportsViewTransition 是纯读函数，无副作用）
  const vt = useMemo(supportsViewTransition, [])
  const expanded = usePlayer((s) => s.expanded)
  // hooks 规则：无条件调用；仅在无 VT 时取用其字段
  const presence = usePresence(expanded, NP_EXIT_MS)
  // VT 路径下同步挂载/卸载（含 reduced-motion），使其进入 View Transition 快照；
  // 完全不支持 VT 时才退回 presence 的延迟挂卸 + 整页上滑降级动画（见 NowPlaying.css）。
  const show = vt ? expanded : presence.mounted
  const exiting = vt ? false : presence.exiting
  return show ? <NowPlaying open={expanded} exiting={exiting} /> : null
}

export default function App() {
  useApplyTheme()
  useAudioEngine()
  useLibrarySync()
  useNowPlayingPrefetch()
  usePlaylistPrefetch()
  useContentScrollRestoration()
  useSourceTheme()
  useAccentFromBackground()

  const searchRef = useRef<HTMLInputElement | null>(null)
  const focusSearch = () => searchRef.current?.focus()
  useKeyboardShortcuts(focusSearch)

  const modalOpen = useAuth((s) => s.modalOpen)
  const location = useLocation()

  // 探测 View Transition 能力并写入 <html data-vt>，供 CSS 降级进场动画判断
  const vt = useMemo(supportsViewTransition, [])
  useEffect(() => {
    document.documentElement.dataset.vt = vt ? 'on' : 'off'
  }, [vt])

  // 首次进入查询登录态（用于 VIP 曲目判断与「我的歌单」）
  const refresh = useAuth((s) => s.refresh)
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="app-shell">
      {/* 全局唯一的 audio 元素，由引擎驱动 */}
      <audio ref={audioEl} preload="metadata" data-testid="audio-engine" />

      {/* 自定义应用背景层（铺在顶栏 / 侧边栏 / 主内容区之下，不含底部播放条） */}
      <AppBackground />

      <Sidebar />

      <div className="app-main">
        <Topbar searchRef={searchRef} />
        <main className="app-content">
          {/*
            内容区转场：
            - 支持 View Transition 时 key 固定，路由切换由 .app-content 的交叉溶解完成；
            - 不支持时按 location.key 强制重挂载，触发 app.css 中的进场动画。
          */}
          <div className="route-stage" key={vt ? 'stage' : location.key}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/browse" element={<Browse />} />
              <Route path="/radio" element={<Radio />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/crate" element={<CratePage />} />
              <Route path="/favorites" element={<FavoritesPage />} />
              <Route path="/recent" element={<RecentPage />} />
              <Route path="/playlist/:source/:id" element={<PlaylistPage />} />
              <Route path="/playlist/:id" element={<PlaylistPage />} />
              <Route path="/artist/:source/:id" element={<ArtistPage />} />
              <Route path="/artist/:id" element={<ArtistPage />} />
              <Route path="/album/:source/:id" element={<AlbumPage />} />
              <Route path="/album/:id" element={<AlbumPage />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </div>
        </main>
      </div>

      <PlayerBar />

      {/* 浮层：全屏播放页 / 队列 / 登录 / 新建歌单 / 设置 / 播放错误 */}
      <NowPlayingLayer />
      <QueuePanel />
      {modalOpen && <LoginModal />}
      <CreatePlaylistModal />
      <ConfirmDialog />
      <SettingsDialog />
      <PlayErrorToast />
    </div>
  )
}
