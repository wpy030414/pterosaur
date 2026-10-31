import { useEffect } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { usePlaybackSession } from '../store/playbackSession.js'
import { useAuth } from '../store/auth.js'
import './PlayErrorToast.css'

/**
 * 播放错误提示条。当曲目因版权 / VIP 限制无法播放时弹出，
 * 提供「登录解锁」入口，5 秒后自动消失。
 */
export function PlayErrorToast() {
  const playError = usePlaybackSession((s) => s.playError)
  const playErrorNeedLogin = usePlaybackSession((s) => s.playErrorNeedLogin)
  const playErrorSource = usePlaybackSession((s) => s.playErrorSource)
  const setPlayError = usePlaybackSession((s) => s.setPlayError)
  const status = useAuth((s) => s.status)
  const openModal = useAuth((s) => s.openModal)

  // 出错曲目所属源：决定「登录解锁」引导到哪个源的登录页
  const src = playErrorSource ?? 'netease'
  const logged = status[src]?.logged ?? false
  // 该源是否支持登录——不支持的源不显示「登录解锁」（`loginable`，缺失视为支持）
  const loginable = status[src]?.loginable !== false

  useEffect(() => {
    if (!playError) return
    const t = window.setTimeout(() => setPlayError(null), 5000)
    return () => window.clearTimeout(t)
  }, [playError, setPlayError])

  if (!playError) return null

  return (
    <div className="toast" role="alert">
      <AlertCircle size={18} className="toast__icon" />
      <span className="toast__text">{playError}</span>
      {!logged && loginable && playErrorNeedLogin && (
        <button
          type="button"
          className="toast__action"
          onClick={() => openModal(src)}
        >
          登录解锁
        </button>
      )}
      <button
        type="button"
        className="toast__close"
        onClick={() => setPlayError(null)}
        aria-label="关闭提示"
      >
        <X size={16} />
      </button>
    </div>
  )
}
