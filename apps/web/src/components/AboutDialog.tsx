import { useEffect, useRef, useState } from 'react'
import { X, RefreshCw, Loader2 } from 'lucide-react'
import { useAboutDialog, confirmDialog } from '../store/ui.js'
import { checkForUpdates } from '../lib/pwa.js'
import { IconButton } from './IconButton.js'
import './AboutDialog.css'

/**
 * 「关于」弹窗：点侧边栏品牌名打开。
 *
 * 只放版本信息与「检查更新」（注销 PWA 缓存 + 强制刷新），从设置弹窗里独立出来——
 * 版本与更新不属于日常偏好，单独一个轻量弹窗更贴合「点 Logo 看看这是什么」的意图。
 */
export function AboutDialog() {
  const open = useAboutDialog((s) => s.open)
  const closeAbout = useAboutDialog((s) => s.closeAbout)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => cardRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAbout()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, closeAbout])

  if (!open) return null

  const handleUpdate = async () => {
    if (busy) return
    const ok = await confirmDialog({
      title: '检查更新？',
      message:
        '将注销离线缓存并强制刷新页面，以拉取最新版本。资料库与本机缓存不受影响。',
      confirmText: '刷新',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    // 结束时页面通常会卸载；若未刷新则恢复按钮
    await checkForUpdates()
    setBusy(false)
  }

  return (
    <div
      className="about-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="关于"
    >
      <div className="about-dialog__scrim" onClick={closeAbout} aria-hidden />
      <div className="about-dialog__card" ref={cardRef} tabIndex={-1}>
        <header className="about-dialog__head">
          <h2>关于</h2>
          <IconButton label="关闭" size="sm" onClick={closeAbout}>
            <X size={18} />
          </IconButton>
        </header>

        <div className="about-dialog__brand">Pterosaur</div>

        <div className="about-dialog__stat">
          <span className="about-dialog__stat-label">版本</span>
          <code className="about-dialog__code">{__COMMIT_HASH__}</code>
        </div>

        <button
          type="button"
          className="about-dialog__btn"
          onClick={handleUpdate}
          disabled={busy}
          data-testid="check-update"
        >
          {busy ? (
            <Loader2 size={15} className="spinner" />
          ) : (
            <RefreshCw size={15} />
          )}
          检查更新
        </button>
      </div>
    </div>
  )
}
