import { useEffect, useState } from 'react'
import { User, LogOut, Settings, Cloud } from 'lucide-react'
import { useAuth, activeSource } from '../store/auth.js'
import { useSync } from '../store/sync.js'
import { useSettingsDialog } from '../store/ui.js'
import { coverAt, COVER_SMALL } from '@pterosaur/shared/image'
import { Cover } from './Cover.js'
import './SidebarFooter.css'

// 计划标签（`Plan N` / `Plan B`）已不再展示：它不反映真实会员状态，且 B 站已无登录入口。

/**
 * 侧边栏底部操作栏：设置 / 账户。
 *
 * 原本位于顶栏（Topbar）；顶栏移除后下沉到这里——侧边栏贯穿全高，底部是这些
 * 全局入口最自然的位置，也避免了在内容区顶部再叠一条工具条。
 * 主题切换已并入设置弹窗的「外观」分区，这里不再提供一级按钮。
 *
 * 账户菜单**向上弹出**：本栏贴着窗口底边，向下弹会被裁掉。菜单是绝对定位、
 * 以本栏为定位上下文，故不依赖 Portal。
 */
export function SidebarFooter() {
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
                <div className="sidebar-footer__menu-name">
                  {account.nickname}
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
