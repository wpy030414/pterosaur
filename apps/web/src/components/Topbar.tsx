import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  User,
  LogOut,
  Menu,
  Settings,
  Cloud,
} from 'lucide-react'
import { useTheme } from '../hooks/useTheme.js'
import { startThemeTransition } from '../lib/themeTransition.js'
import { useViewNavigate } from '../hooks/useViewNavigate.js'
import { useAuth, activeSource } from '../store/auth.js'
import type { MusicSource } from '@pterosaur/shared/types'
import { useSync } from '../store/sync.js'
import { useSidebarDrawer, useSettingsDialog } from '../store/ui.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './Topbar.css'

interface TopbarProps {
  searchRef: React.RefObject<HTMLInputElement | null>
}

/** 会员计划标签：网易云 → `Plan N`，B 站 → `Plan B`。 */
const PLAN_LETTER: Record<MusicSource, string> = {
  netease: 'N',
  bilibili: 'B',
}
const planOf = (src: MusicSource): string => `Plan ${PLAN_LETTER[src]}`

/**
 * 顶部栏：前进/后退、全局搜索、主题切换、账户菜单。
 *
 * 采用半透明毛玻璃 + sticky，滚动时内容从其下方穿过。
 */
export function Topbar({ searchRef }: TopbarProps) {
  const navigate = useViewNavigate()
  const [params] = useSearchParams()
  const [keyword, setKeyword] = useState(params.get('q') ?? '')
  const mode = useTheme((s) => s.mode)
  const setMode = useTheme((s) => s.setMode)
  const status = useAuth((s) => s.status)
  const openModal = useAuth((s) => s.openModal)
  const logout = useAuth((s) => s.logout)
  // 单活动账号：最多一个源登录；登录后不再显示登录入口，只有退出。
  const src = activeSource(status)
  const account = src ? status[src] : undefined
  const [menuOpen, setMenuOpen] = useState(false)
  const toggleSidebar = useSidebarDrawer((s) => s.toggleSidebar)
  const openSettings = useSettingsDialog((s) => s.openSettings)
  const syncEnabled = useSync((s) => s.enabled)

  /** 切换云同步开关：开启时绑定当前账号（进入同步即触发一次「云端权威」同步，见 useLibrarySync）。 */
  const toggleSync = () => {
    const store = useSync.getState()
    if (store.enabled) store.disable()
    else store.enable(src ?? undefined, account?.userId)
  }

  // URL 上的 q 变化时同步输入框（例如从其他页面跳来搜索）
  useEffect(() => {
    setKeyword(params.get('q') ?? '')
  }, [params])

  // 点击外部关闭账户菜单
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = keyword.trim()
    if (!q) return
    navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  // 解析当前系统偏好下的「实际」明暗，用于决定切换目标与图标
  const prefersDark =
    mode === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
      : mode === 'dark'

  // 切换主题：自按钮中心做圆形揭示转场（不支持 VT / 减少动效时内部自动降级为直连）
  const toggleTheme = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const origin = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
    startThemeTransition(origin, () => setMode(prefersDark ? 'light' : 'dark'))
  }

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar__burger"
        onClick={toggleSidebar}
        aria-label="打开侧边栏"
      >
        <Menu size={20} strokeWidth={2} />
      </button>

      <div className="topbar__nav">
        <button
          type="button"
          className="topbar__round"
          onClick={() => navigate(-1)}
          aria-label="后退"
        >
          <ChevronLeft size={18} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          className="topbar__round"
          onClick={() => navigate(1)}
          aria-label="前进"
        >
          <ChevronRight size={18} strokeWidth={2.4} />
        </button>
      </div>

      <form className="topbar__search" onSubmit={submit} role="search">
        <Search size={16} strokeWidth={2.2} className="topbar__search-icon" />
        <input
          ref={searchRef}
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索歌曲、艺人、专辑…"
          aria-label="搜索"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
        />
      </form>

      <div className="topbar__actions">
        <button
          type="button"
          className="topbar__round"
          onClick={toggleTheme}
          aria-label={prefersDark ? '切换到浅色' : '切换到深色'}
          title={prefersDark ? '浅色模式' : '深色模式'}
        >
          {prefersDark ? (
            <Sun size={17} strokeWidth={2} />
          ) : (
            <Moon size={17} strokeWidth={2} />
          )}
        </button>

        <button
          type="button"
          className="topbar__round"
          onClick={openSettings}
          aria-label="设置"
          title="设置"
          data-testid="settings-button"
        >
          <Settings size={17} strokeWidth={2} />
        </button>

        {account && src ? (
          <div className="topbar__account">
            <button
              type="button"
              className="topbar__avatar"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
              aria-label="账户菜单"
              aria-expanded={menuOpen}
            >
              <Cover
                src={coverAt(account.avatarUrl, COVER_SMALL)}
                alt={account.nickname ?? '用户'}
                rounded
                size={28}
              />
            </button>
            {menuOpen && (
              <div
                className="topbar__menu"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="topbar__menu-head">
                  <Cover
                    src={coverAt(account.avatarUrl, COVER_SMALL)}
                    alt=""
                    rounded
                    size={36}
                  />
                  <div>
                    <div className="topbar__menu-name">{account.nickname}</div>
                    <div className="topbar__menu-plan">{planOf(src)}</div>
                  </div>
                </div>

                <button
                  type="button"
                  className="topbar__menu-item topbar__menu-item--switch"
                  onClick={toggleSync}
                  aria-pressed={syncEnabled}
                  data-testid="sync-toggle"
                >
                  <Cloud size={15} />
                  <span>{syncEnabled ? '云同步已开启' : '开启云同步'}</span>
                  <span
                    className={`topbar__switch${syncEnabled ? ' topbar__switch--on' : ''}`}
                    aria-hidden
                  >
                    <span className="topbar__switch-knob" />
                  </span>
                </button>

                <button
                  type="button"
                  className="topbar__menu-item"
                  onClick={() => {
                    void logout(src)
                    setMenuOpen(false)
                  }}
                >
                  <LogOut size={15} /> 退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="topbar__login"
            onClick={() => openModal()}
          >
            <User size={16} strokeWidth={2.1} />
            <span>登录</span>
          </button>
        )}
      </div>
    </header>
  )
}
