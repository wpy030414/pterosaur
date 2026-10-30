import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Search,
  LayoutGrid,
  Radio,
  Star,
  User,
  Disc3,
  Plus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { keyOf } from '@pterosaur/shared/types'
import { useLibrary } from '../store/library.js'
import { useCreatePlaylist, useSidebarDrawer } from '../store/ui.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { AppLink } from './AppLink.js'
import { SidebarGroup } from './SidebarGroup.js'
import { SidebarFooter } from './SidebarFooter.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import { useMediaQuery, MOBILE_QUERY } from '../hooks/useMediaQuery.js'
import './Sidebar.css'

interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
  /** 是否仅精确匹配时高亮（用于根路由 `/`）。 */
  end?: boolean
}

/**
 * 主导航（三项，平铺在侧边栏顶部）。
 *
 * 「搜索」是独立页面而非覆盖层：顶栏移除后，搜索需要一个真正的落点。
 */
const NAV: NavEntry[] = [
  { to: '/search', label: '搜索', icon: Search },
  { to: '/', label: '新发现', icon: LayoutGrid, end: true },
  { to: '/radio', label: '广播', icon: Radio },
]

/** 本项目 GitHub 地址。 */
const REPO_URL = 'https://github.com/wpy030414/pterosaur'

/** GitHub 标记（lucide 1.x 已移除品牌图标，故内联 SVG）。 */
function GitHubMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/**
 * 侧边栏（贯穿全高）。
 *
 * 结构：品牌 → 可滚动导航区 → 底部操作栏（主题 / 设置 / 账户）。
 *
 * 信息架构：
 * - 顶部三项平铺：搜索 / 新发现 / 广播；
 * - 「库」：最近播放、艺术家、专辑（艺术家与专辑原先合在「唱片盒」一页，现拆分）；
 * - 「歌单」：我喜欢的音乐固定开头，其后为自建歌单与收藏的歌单（两类间浅虚线分隔）。
 *
 * 「库」与「歌单」标题可点击折叠，展开态持久化（见 `store/sidebarPrefs`）。
 */
export function Sidebar() {
  const playlists = useLibrary((s) => s.playlists)
  const savedPlaylists = useLibrary((s) => s.savedPlaylists)
  const openCreate = useCreatePlaylist((s) => s.openCreate)
  const sidebarOpen = useSidebarDrawer((s) => s.sidebarOpen)
  const setSidebarOpen = useSidebarDrawer((s) => s.setSidebarOpen)
  const navigate = useViewNavigate()
  const { pathname } = useLocation()
  const isMobile = useMediaQuery(MOBILE_QUERY)

  // 移动端抽屉：地址一变就自动收纳，不必再点遮罩。
  // 按 pathname 而非点击事件来收，这样导航项、侧栏内「新建歌单」的跳转、
  // 浏览器前进/后退三条入口都能一并覆盖。
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [pathname, isMobile, setSidebarOpen])

  // 点击标题切换：在品牌名与当前 commit 短哈希之间来回
  const [showHash, setShowHash] = useState(false)

  const handleCreate = () => {
    openCreate({ onDone: (id) => navigate(`/playlist/${id}`) })
  }

  return (
    <>
      {/* 窄屏半透明遮罩（点击关闭） */}
      <div
        className={`sidebar-scrim${sidebarOpen ? ' sidebar-scrim--visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`sidebar${sidebarOpen ? ' sidebar--drawer-open' : ''}`}>
        <div className="sidebar__brand">
          <button
            type="button"
            className="sidebar__name"
            onClick={() => setShowHash((v) => !v)}
            title={showHash ? '显示名称' : '显示当前 commit'}
          >
            {showHash ? __COMMIT_HASH__ : 'Pterosaur'}
          </button>
          <a
            className="sidebar__github"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 GitHub 上查看本项目"
            title="GitHub"
          >
            <GitHubMark />
          </a>
        </div>

        <div className="sidebar__scroll">
          <nav className="sidebar__nav" aria-label="主导航">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <AppLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `nav-item${isActive ? ' nav-item--active' : ''}`
                }
              >
                <Icon size={19} strokeWidth={1.9} />
                <span className="nav-item__label">{label}</span>
              </AppLink>
            ))}
          </nav>

          <SidebarGroup groupKey="library" label="库">
            <AppLink
              to="/library/artists"
              className={({ isActive }) =>
                `nav-item${isActive ? ' nav-item--active' : ''}`
              }
            >
              <User size={19} strokeWidth={1.9} />
              <span className="nav-item__label">艺术家</span>
            </AppLink>
            <AppLink
              to="/library/albums"
              className={({ isActive }) =>
                `nav-item${isActive ? ' nav-item--active' : ''}`
              }
            >
              <Disc3 size={19} strokeWidth={1.9} />
              <span className="nav-item__label">专辑</span>
            </AppLink>
          </SidebarGroup>

          <SidebarGroup
            groupKey="playlists"
            label="歌单"
            action={
              <button
                type="button"
                className="sidebar__add"
                onClick={handleCreate}
                aria-label="新建歌单"
                title="新建歌单"
              >
                <Plus size={17} strokeWidth={2.2} />
              </button>
            }
          >
            {/* 「我喜欢的音乐」固定为歌单区第一项 */}
            <AppLink
              to="/favorites"
              className={({ isActive }) =>
                `nav-item${isActive ? ' nav-item--active' : ''}`
              }
            >
              <Star size={19} strokeWidth={1.9} />
              <span className="nav-item__label">我喜欢的音乐</span>
            </AppLink>

            {playlists.map((p) => (
              <AppLink
                key={p.id}
                to={`/playlist/${p.id}`}
                className={({ isActive }) =>
                  `nav-item${isActive ? ' nav-item--active' : ''}`
                }
              >
                <Cover
                  src={coverAt(p.tracks[0]?.cover, COVER_SMALL)}
                  alt={p.name}
                  seed={keyOf({ id: p.id })}
                  radius="sm"
                  size={19}
                />
                <span className="nav-item__label">{p.name}</span>
              </AppLink>
            ))}

            {playlists.length > 0 && savedPlaylists.length > 0 && (
              <div className="sidebar__playlist-divider" aria-hidden />
            )}

            {savedPlaylists.map((p) => (
              <AppLink
                key={p.id}
                to={`/playlist/${p.source}/${p.id}`}
                className={({ isActive }) =>
                  `nav-item${isActive ? ' nav-item--active' : ''}`
                }
              >
                <Cover
                  src={coverAt(p.cover, COVER_SMALL)}
                  alt={p.name}
                  seed={keyOf(p)}
                  radius="sm"
                  size={19}
                />
                <span className="nav-item__label">{p.name}</span>
              </AppLink>
            ))}
          </SidebarGroup>
        </div>

        <SidebarFooter />
      </aside>
    </>
  )
}
