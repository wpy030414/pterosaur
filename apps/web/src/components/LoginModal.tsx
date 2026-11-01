import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Loader2, CheckCircle2 } from 'lucide-react'
import { MUSIC_SOURCES } from '@pterosaur/shared/types'
import type { MusicSource } from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { useAuth, finishQrLogin } from '../store/auth.js'
import { IconButton } from './IconButton.js'
import './LoginModal.css'

/** 扫码状态：loading 加载中 / waiting 等待扫码 / scanned 待确认 / expired 已过期 / done 成功 */
type QrStage = 'loading' | 'waiting' | 'scanned' | 'expired' | 'done'

/** 登录方式：扫码 / 粘贴 cookie。 */
type LoginMethod = 'qr' | 'cookie'

/** 扫码轮询间隔（上一轮响应回来后再等这么久才发下一轮）。 */
const POLL_INTERVAL_MS = 1000

/** 扫码各阶段的文案。 */
const STAGE_TEXT: Record<QrStage, string> = {
  loading: '二维码加载中…',
  waiting: '打开网易云音乐 App 扫码登录',
  scanned: '扫码成功，请在手机上确认',
  expired: '二维码已过期，点击刷新',
  done: '登录成功',
}

/**
 * 网易云扫码撞上游**设备风控**（8821）时的提示：不是二维码过期，重开弹窗也多半无用，
 * 应引导改用另一个登录方式（见 `sources/neteaseDevice.ts`）。返回 `null` 表示非风控。
 */
function riskMessage(message: string | undefined, code: number | undefined) {
  if (code === 8821 || message?.includes('切换其他登录方式'))
    return '扫码被网易云风控拦截。请改用「粘贴 Cookie」登录。'
  return null
}

/**
 * 登录弹窗：只面向**音乐源**（现为网易云；磁带渠道 B 站不提供登录入口），两种方式——
 *
 * - **扫码**：`/api/auth/:source/qr` 取 key+图片 → 每 1s 轮询 `/qr/check`（响应后再隔 1s）
 *   → 803 成功时后端下发会话 Set-Cookie；
 * - **粘贴 Cookie**：用户从自己已登录的浏览器 DevTools 复制 cookie，
 *   `POST /api/auth/:source/cookie` 校验后下发会话 Set-Cookie —— 绕开会撞 8821 的扫码风控。
 *
 * 两条路径的后端落库方式一致：cookie 写进浏览器，后续请求由后端透传。
 */
export function LoginModal() {
  const closeModal = useAuth((s) => s.closeModal)
  const error = useAuth((s) => s.error)
  const setError = useAuth((s) => s.setError)
  const modalSource = useAuth((s) => s.modalSource)

  // 实际生效的源：弹窗打开时给定的源（须是音乐源），否则第一个音乐源。
  // 磁带渠道（B 站）没有登录入口，但它播放出错时仍会调 `openModal('bilibili')`，故需回落到音乐源。
  const loginSource: MusicSource = (
    MUSIC_SOURCES as readonly MusicSource[]
  ).includes(modalSource)
    ? modalSource
    : MUSIC_SOURCES[0]

  const [method, setMethod] = useState<LoginMethod>('qr')

  // 扫码状态
  const [qrimg, setQrimg] = useState('')
  const [stage, setStage] = useState<QrStage>('loading')
  const timerRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  /** 轮询代号：每次 startQr 自增，旧代号响应的回包一律丢弃。 */
  const genRef = useRef(0)

  // cookie 状态
  const [cookieText, setCookieText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const startQr = useCallback(
    async (src: MusicSource) => {
      stopPolling()
      // 代号：新一轮开始即作废旧轮询（含进行中的 qrCreate/qrCheck），
      // 防止旧轮延迟的回包把状态顶回 waiting（见 genRef）
      const gen = ++genRef.current
      setStage('loading')
      setQrimg('')
      setError(null)
      try {
        const { key: k, qrimg: img } = await api.qrCreate(src)
        if (!aliveRef.current || genRef.current !== gen) return
        setQrimg(img)
        setStage('waiting')
        // 轮询扫码状态：「响应后 1s 再发下一次」的自串联，后端单次 qr/check 变慢时不会堆积请求
        const poll = async () => {
          if (!aliveRef.current) return
          try {
            const res = await api.qrCheck(src, k)
            if (!aliveRef.current || genRef.current !== gen) return
            const code = res.code ?? 800
            const risk = riskMessage(res.message, code)
            // 风控拦截（8821）：这张码已废，立即停轮询并引导换方式——先于下面的分支判定，
            // 避免任何落空分支把它的回包再续排一轮
            if (risk) {
              stopPolling()
              setStage('expired')
              setError(risk)
              return
            }
            if (code === 803) {
              stopPolling()
              // 只有后端确认建立了会话（logged）才算成功——否则如实报错，避免"看着登录了、刷新就掉"。
              if (res.logged) {
                setStage('done')
                finishQrLogin(src, {
                  logged: true,
                  nickname: res.nickname,
                  avatarUrl: res.avatarUrl,
                  userId: res.userId,
                  vip: res.vip,
                  loginable: true,
                })
              } else {
                setStage('expired')
                setError(res.message ?? '登录成功但未能建立会话，请重试')
              }
            } else if (code === 802) {
              setStage('scanned')
            } else if (code === 800) {
              setStage('expired')
              stopPolling()
            } else {
              setStage((s) => (s === 'scanned' ? 'scanned' : 'waiting'))
            }
          } catch {
            /* 轮询失败静默重试 */
          }
          // 下一轮：响应回来后再排 1s（弹窗已关或已换代则不再续）
          if (aliveRef.current && genRef.current === gen) {
            timerRef.current = window.setTimeout(
              () => void poll(),
              POLL_INTERVAL_MS,
            )
          }
        }
        void poll()
      } catch (e) {
        if (!aliveRef.current) return
        setStage('expired')
        setError((e as Error).message)
      }
    },
    [stopPolling, setError],
  )

  // 打开弹窗默认走扫码；关闭 / 卸载时停掉轮询
  useEffect(() => {
    if (method !== 'qr') return
    aliveRef.current = true
    void startQr(loginSource)
    return () => {
      aliveRef.current = false
      stopPolling()
    }
  }, [method, loginSource, startQr, stopPolling])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeModal])

  const submitCookie = useCallback(async () => {
    if (!cookieText.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const status = await api.cookieLogin(loginSource, cookieText)
      finishQrLogin(loginSource, { ...status, loginable: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }, [cookieText, submitting, loginSource, setError])

  return (
    <div
      className="login-modal"
      role="dialog"
      aria-modal="true"
      aria-label="登录"
    >
      <div className="login-modal__scrim" onClick={closeModal} aria-hidden />
      <div className="login-modal__card">
        <header className="login-modal__head">
          <h2>登录网易云音乐</h2>
          <IconButton label="关闭" size="sm" onClick={closeModal}>
            <X size={18} />
          </IconButton>
        </header>

        <p className="login-modal__hint">
          登录后可享用免费云同步服务，并解锁 VIP 曲目。
        </p>

        <div className="login-modal__tabs" role="tablist" aria-label="登录方式">
          {(
            [
              ['qr', '扫描二维码'],
              ['cookie', '自提供 Cookie'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={method === m}
              className={`login-modal__tab${method === m ? ' login-modal__tab--active' : ''}`}
              onClick={() => {
                setError(null)
                setMethod(m)
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {method === 'qr' ? (
          <div className="login-modal__qr">
            <div
              className={`login-modal__qr-box${stage === 'expired' || stage === 'done' ? ' login-modal__qr-box--mask' : ''}`}
            >
              {qrimg ? (
                <img src={qrimg} alt="登录二维码" />
              ) : (
                <Loader2 size={28} className="spinner" />
              )}
              {stage === 'expired' && (
                <button
                  type="button"
                  className="login-modal__qr-refresh"
                  onClick={() => void startQr(loginSource)}
                >
                  点击刷新
                </button>
              )}
              {stage === 'done' && (
                <div className="login-modal__qr-done">
                  <CheckCircle2 size={36} />
                </div>
              )}
            </div>
            <p className="login-modal__qr-text">{STAGE_TEXT[stage]}</p>
          </div>
        ) : (
          <form
            className="login-modal__cookie"
            onSubmit={(e) => {
              e.preventDefault()
              void submitCookie()
            }}
          >
            <ol className="login-modal__cookie-steps">
              <li>
                在浏览器打开 <b>music.163.com</b> 并登录；
              </li>
              <li>
                按 <kbd>F12</kbd> →「应用 / Application」→「Cookie」→
                <b>https://music.163.com</b>；
              </li>
              <li>
                复制 <b>MUSIC_U</b> 的值（或整段 cookie），粘贴到下面。
              </li>
            </ol>
            <textarea
              className="login-modal__cookie-input"
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              placeholder="MUSIC_U=… 或直接粘贴 MUSIC_U 的值"
              spellCheck={false}
              rows={3}
              aria-label="网易云 cookie"
            />
            <button
              type="submit"
              className="login-modal__cookie-submit"
              disabled={!cookieText.trim() || submitting}
            >
              {submitting ? '验证中…' : '登录'}
            </button>
          </form>
        )}

        {error && (
          <p className="login-modal__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
