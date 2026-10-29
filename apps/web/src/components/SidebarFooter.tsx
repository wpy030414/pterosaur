import { useEffect, useState } from 'react'
import { Sun, Moon, User, LogOut, Settings, Cloud } from 'lucide-react'
import { useTheme } from '../hooks/useTheme.js'
import { startThemeTransition } from '../lib/themeTransition.js'
import { useAuth, activeSource } from '../store/auth.js'
import type { MusicSource } from '@pterosaur/shared/types'
import { useSync } from '../store/sync.js'
import { useSettingsDialog } from '../store/ui.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './SidebarFooter.css'

/** 会员计划标签：网易云 → `Plan N`，B 站 → `Plan B`。 */
const PLAN_LETTER: Record<MusicSource, string> = {
  netease: 'N',
  bilibili: 'B',
}
const planOf = (src: MusicSource): string => `Plan ${PLAN_LETTER[src]}`

/**
 * 侧边栏底部操作栏：主题切换 / 设置 / 账户。
 *
 * 原本位于顶栏（Topbar）；顶栏移除后下沉到这里——侧边栏贯穿全高，底部是这些
 * 全局入口最自然的位置，也避免了在内容区顶部再叠一条工具条。
 *
 * 账户菜单**向上弹出**：本栏贴着窗口底边，向下弹会被裁掉。菜单是绝对定位、
 * 以本栏为定位上下文，故不依赖 Portal。
 */
export function SidebarFooter() {
  const mode = useTheme((s) => s.mode)
  const setMode = useTheme((s) => s.setMode)
  const status = useAuth((s) => s.status)
  const openModal = useAuth((s) => s.openModal)
  const logout = useAuth((s) => s.logout)
  const openSettings = useSettingsDialog((s) => s.openSettings)
  const syncEnabled = useSync((s) => s.enabled)

  // 单活动账号：最多一个源登录；登录后不再显示登录入口，只有退出。
  const src = activeSource(status)
  const account = src ? status[src] : undefined

  const [menuOpen, setMenuOpen] = useState(false)

  // 点击外部关闭账户菜单
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

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

  /** 切换云同步开关：开启时绑定当前账号（进入同步即触发一次「云端权威」同步，见 useLibrarySync）。 */
  const toggleSync = () => {
    const store = useSync.getState()
    if (store.enabled) store.disable()
    else store.enable(src ?? undefined, account?.userId)
  }

  return (
    <div className="sidebar-footer">
      <button
        type="button"
        className="sidebar-footer__btn"
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
        className="sidebar-footer__btn"
        onClick={openSettings}
        aria-label="设置"
        title="设置"
        data-testid="settings-button"
      >
        <Settings size={17} strokeWidth={2} />
      </button>

      <div className="sidebar-footer__spacer" />

      {account && src ? (
        <div className="sidebar-footer__account">
          <button
            type="button"
            className="sidebar-footer__avatar"
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
              size={26}
            />
          </button>

          {menuOpen && (
            <div
              className="sidebar-footer__menu"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sidebar-footer__menu-head">
                <Cover
                  src={coverAt(account.avatarUrl, COVER_SMALL)}
                  alt=""
                  rounded
                  size={36}
                />
                <div>
                  <div className="sidebar-footer__menu-name">
                    {account.nickname}
                  </div>
                  <div className="sidebar-footer__menu-plan">{planOf(src)}</div>
                </div>
              </div>

              <button
                type="button"
                className="sidebar-footer__menu-item sidebar-footer__menu-item--switch"
                onClick={toggleSync}
                aria-pressed={syncEnabled}
                data-testid="sync-toggle"
              >
                <Cloud size={15} />
                <span>{syncEnabled ? '云同步已开启' : '开启云同步'}</span>
                <span
                  className={`sidebar-footer__switch${syncEnabled ? ' sidebar-footer__switch--on' : ''}`}
                  aria-hidden
                >
                  <span className="sidebar-footer__switch-knob" />
                </span>
              </button>

              <button
                type="button"
                className="sidebar-footer__menu-item"
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
          className="sidebar-footer__login"
          onClick={() => openModal()}
        >
          <User size={16} strokeWidth={2.1} />
          <span>登录</span>
        </button>
      )}
    </div>
  )
}
