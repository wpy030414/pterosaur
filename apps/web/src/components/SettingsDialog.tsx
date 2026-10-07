import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  X,
  Trash2,
  RefreshCw,
  Loader2,
  RotateCcw,
  Image as ImageIcon,
} from 'lucide-react'
import { AUDIO_LEVELS, type AudioLevel } from '@pterosaur/shared/types'
import { useSettingsDialog, confirmDialog } from '../store/ui.js'
import { useSync } from '../store/sync.js'
import { useSettings } from '../store/settings.js'
import {
  clearMediaCache,
  mediaUsage,
  type MediaUsage,
} from '../lib/mediaCache.js'
import { checkForUpdates, postToServiceWorker } from '../lib/pwa.js'
import { pushEmptyLibrary } from '../lib/sync.js'
import { resetAll } from '../lib/reset.js'
import { removeBackground, saveBackground } from '../lib/background.js'
import { accentFromBlob } from '../lib/accent.js'
import { formatBytes } from '../lib/formatBytes.js'
import { IconButton } from './IconButton.js'
import './SettingsDialog.css'

type Busy = 'clear' | 'update' | 'reset' | null

/** 音质档位显示名（键与顺序同 shared `AUDIO_LEVELS`）。 */
const QUALITY_LABELS: Record<AudioLevel, string> = {
  standard: '标准',
  higher: '较高',
  exhigh: '极高',
  lossless: '无损',
  hires: 'Hi-Res',
}

/**
 * 设置弹窗：缓存管理（查看占用 / 清理）与检查更新（注销 PWA + 强制刷新）。
 *
 * 由 {@link useSettingsDialog} store 驱动，挂载在 App 顶层，顶栏齿轮按钮打开。
 */
export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open)
  const closeSettings = useSettingsDialog((s) => s.closeSettings)
  const level = useSettings((s) => s.level)
  const setLevel = useSettings((s) => s.setLevel)
  const background = useSettings((s) => s.background)
  const setBackground = useSettings((s) => s.setBackground)

  const [usage, setUsage] = useState<MediaUsage | null>(null)
  const [quota, setQuota] = useState<number | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [bgError, setBgError] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setUsage(await mediaUsage())
    try {
      if (navigator.storage?.estimate) {
        const { quota: q } = await navigator.storage.estimate()
        setQuota(q ?? null)
      }
    } catch {
      /* 配额信息不可用时忽略 */
    }
  }, [])

  // 打开时刷新用量、聚焦弹窗；Esc 关闭
  useEffect(() => {
    if (!open) return
    void refresh()
    const id = window.setTimeout(() => cardRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, refresh, closeSettings])

  if (!open) return null

  const total = usage?.bytes ?? 0

  const handleClear = async () => {
    if (busy) return
    setBusy('clear')
    try {
      await clearMediaCache()
      // 通知 SW 清空其内存中的元数据索引，避免清缓存后 LRU 仍按旧账目淘汰
      postToServiceWorker({ type: 'MEDIA_CACHE_CLEARED' })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

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
    setBusy('update')
    // 结束时页面通常会卸载；若未刷新则恢复按钮
    await checkForUpdates()
    setBusy(null)
  }

  const handlePickBackground = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许再次选择同一文件
    if (!file) return
    setBgBusy(true)
    setBgError(false)
    try {
      const kind = file.type.startsWith('video') ? 'video' : 'image'
      await saveBackground(file)
      // 自动取色作为主题色（失败则回落默认红）
      const accent = await accentFromBlob(file)
      setBackground({ kind, mime: file.type, accent: accent ?? '#fa243c' })
    } catch (err) {
      // 写入失败（如 IndexedDB 不可用 / background store 缺失）→ 明示，且**不落配置**
      console.warn('[settings] 设置背景失败', err)
      setBgError(true)
    } finally {
      setBgBusy(false)
    }
  }

  const handleClearBackground = async () => {
    if (bgBusy) return
    setBgBusy(true)
    setBgError(false)
    try {
      await removeBackground()
      setBackground(null)
    } finally {
      setBgBusy(false)
    }
  }

  const handleReset = async () => {
    if (busy) return
    const syncing = useSync.getState().enabled
    const ok = await confirmDialog({
      title: '重置？',
      message:
        '将清空本机的全部内容（资料库、缓存、偏好设置）并刷新，不可恢复；若已开启云同步，云端资料库也会一并清空。登录状态保留。',
      confirmText: '重置',
      danger: true,
    })
    if (!ok) return
    setBusy('reset')
    try {
      // 已开启云同步：先推送空 library 清空云端副本，再清本机（顺序不可颠倒）
      if (syncing) {
        await pushEmptyLibrary().catch((e) =>
          console.warn('[reset] 清空云端 library 失败', e),
        )
      }
      await resetAll()
    } finally {
      setBusy(null) // 通常因刷新而卸载；若未刷新则恢复按钮
    }
  }

  return (
    <div
      className="settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <div
        className="settings-dialog__scrim"
        onClick={closeSettings}
        aria-hidden
      />
      <div className="settings-dialog__card" ref={cardRef} tabIndex={-1}>
        <header className="settings-dialog__head">
          <h2>设置</h2>
          <IconButton label="关闭" size="sm" onClick={closeSettings}>
            <X size={18} />
          </IconButton>
        </header>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">音质</h3>
          <p className="settings-dialog__desc">
            播放与下载的音质档位；该曲不可得时自动降级到最接近的可得档。
          </p>
          <div
            className="settings-dialog__segmented"
            role="radiogroup"
            aria-label="音质"
          >
            {AUDIO_LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                role="radio"
                aria-checked={level === lv}
                className={`settings-dialog__seg-btn${level === lv ? ' settings-dialog__seg-btn--active' : ''}`}
                onClick={() => setLevel(lv)}
                data-testid={`quality-${lv}`}
              >
                {QUALITY_LABELS[lv]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">背景</h3>
          <p className="settings-dialog__desc">
            自定义应用背景，并自动从背景中取主题色。
          </p>
          <div className="settings-dialog__btnrow">
            <button
              type="button"
              className="settings-dialog__btn settings-dialog__btn--neutral"
              onClick={() => fileRef.current?.click()}
              disabled={bgBusy}
              data-testid="pick-background"
            >
              {bgBusy ? (
                <Loader2 size={15} className="spinner" />
              ) : (
                <ImageIcon size={15} />
              )}
              {background ? '更换背景' : '上传背景'}
            </button>
            {background && (
              <button
                type="button"
                className="settings-dialog__btn settings-dialog__btn--danger"
                onClick={handleClearBackground}
                disabled={bgBusy}
                data-testid="clear-background"
              >
                <Trash2 size={15} /> 清除背景
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            hidden
            data-testid="background-input"
            onChange={handlePickBackground}
          />
          {bgError && (
            <p className="settings-dialog__error" data-testid="background-error">
              背景保存失败，请重试；若仍失败可刷新页面后再试。
            </p>
          )}
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">更新</h3>
          <p className="settings-dialog__desc">
            当前版本{' '}
            <code className="settings-dialog__code">{__COMMIT_HASH__}</code>。
          </p>
          <button
            type="button"
            className="settings-dialog__btn settings-dialog__btn--primary"
            onClick={handleUpdate}
            disabled={busy !== null}
            data-testid="check-update"
          >
            {busy === 'update' ? (
              <Loader2 size={15} className="spinner" />
            ) : (
              <RefreshCw size={15} />
            )}
            检查更新
          </button>
        </section>

        <section className="settings-dialog__section">
          <h3 className="settings-dialog__section-title">缓存与数据</h3>
          <div className="settings-dialog__stat">
            <span className="settings-dialog__stat-label">已占用</span>
            <span
              className="settings-dialog__stat-value"
              data-testid="cache-total"
            >
              {formatBytes(total)}
            </span>
          </div>
          <p
            className="settings-dialog__breakdown"
            data-testid="cache-breakdown"
          >
            歌曲 {formatBytes(usage?.audioBytes ?? 0)} · 封面{' '}
            {formatBytes(usage?.imageBytes ?? 0)}
            {quota ? ` · 浏览器配额 ${formatBytes(quota)}` : ''}
          </p>
          <div className="settings-dialog__btnrow">
            <button
              type="button"
              className="settings-dialog__btn settings-dialog__btn--neutral"
              onClick={handleClear}
              disabled={busy !== null}
              data-testid="clear-cache"
            >
              {busy === 'clear' ? (
                <Loader2 size={15} className="spinner" />
              ) : (
                <Trash2 size={15} />
              )}
              清理缓存
            </button>
            <button
              type="button"
              className="settings-dialog__btn settings-dialog__btn--danger"
              onClick={handleReset}
              disabled={busy !== null}
              data-testid="reset-all"
            >
              {busy === 'reset' ? (
                <Loader2 size={15} className="spinner" />
              ) : (
                <RotateCcw size={15} />
              )}
              重置
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
