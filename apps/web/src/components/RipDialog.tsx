import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import {
  AUDIO_CD_MAX_SECONDS,
  audioCdFitsTotal,
  isLoopbackHost,
  type DiscType,
  type RipCapabilities,
  type RipDistribution,
} from '@pterosaur/shared/rip'
import { api } from '../api/client.js'
import { useRipDialog } from '../store/ui.js'
import './RipDialog.css'

interface RipDialogProps {
  /**
   * 是否本机（回环）访问；缺省按 `location.hostname` 判定。
   * 作为**测试注入缝**：jsdom 里改 hostname 不便，直接以 prop 驱动门控分支。
   */
  loopback?: boolean
}

/**
 * 翻录方式选择弹窗（见 ADR-047/048）。
 *
 * 由 {@link useRipDialog} store 驱动：调用方 `await ripDialog({...})` 打开，
 * 用户选定「后续将数字分发」（JSZip 打包）或「后续将实体分发」（后端直刻 CD，附光盘类型），
 * 取消回填 null。实体链路仅在**本机访问**时开放；刻录能力（刻录机 / 介质 / ffmpeg）
 * 在打开时拉取 `GET /api/rip/capabilities`，缺失项就地给出原因并禁用对应选项。
 */
export function RipDialog({ loopback: loopbackProp }: RipDialogProps = {}) {
  const open = useRipDialog((s) => s.open)
  const options = useRipDialog((s) => s.options)
  const settle = useRipDialog((s) => s.settle)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  const loopback = loopbackProp ?? isLoopbackHost(window.location.hostname)

  const [dist, setDist] = useState<RipDistribution>('digital')
  const [discType, setDiscType] = useState<DiscType>('data')
  const [caps, setCaps] = useState<RipCapabilities | null>(null)
  const [capsLoading, setCapsLoading] = useState(false)
  const [capsError, setCapsError] = useState(false)

  const loadCaps = useCallback(async () => {
    if (!loopback) return
    setCapsLoading(true)
    setCapsError(false)
    try {
      setCaps(await api.ripCapabilities())
    } catch {
      setCaps(null)
      setCapsError(true)
    } finally {
      setCapsLoading(false)
    }
  }, [loopback])

  // 打开时复位选择并拉取刻录能力（非本机不发请求）；Esc 视为取消
  useEffect(() => {
    if (!open) return
    setDist('digital')
    setDiscType('data')
    setCaps(null)
    void loadCaps()
    const id = window.setTimeout(() => confirmRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, settle, loadCaps])

  if (!open || !options) return null

  const recorderCount = caps?.recorders.length ?? 0
  /** 介质处于可写就绪态（能力查询里两种格式的支持位以此刻为准）。 */
  const mediaUsable = !!caps?.media.present && caps.media.blank

  /** 实体链路不可用的原因（null = 可用）。 */
  const physicalReason = !loopback
    ? '仅在本机（localhost / 127.0.0.1 / ::1）访问时可用——直刻的是后端所在设备的光驱'
    : options.mixedSources
      ? '合集曲目跨多个音源，无法直刻（可改用数字分发）'
      : capsLoading
        ? '正在检测刻录机…'
        : capsError || !caps
          ? '无法获取刻录能力'
          : !caps.supported
            ? (caps.reason ?? '当前平台不支持直刻')
            : recorderCount === 0
              ? '未检测到刻录机'
              : !caps.media.present
                ? '光驱中未放入光盘（请放入空白 CD-R）'
                : !caps.media.blank
                  ? '光盘不可写（非空白 / 已终结 / 写保护），请更换空白 CD-R'
                  : null

  /** 数据 CD 不可用的原因（null = 可用；仅介质就绪时才有意义）。 */
  const dataReason =
    mediaUsable && caps!.media.dataSupported === false
      ? '当前介质不支持数据刻录（请更换空白 CD-R / CD-RW）'
      : null

  /** 音频 CD 不可用的原因（null = 可用；仅介质就绪时才有意义）。 */
  const audioFits = audioCdFitsTotal(options.totalDuration, options.trackCount)
  const audioReason = mediaUsable
    ? caps!.media.audioSupported === false
      ? '当前光驱或介质不支持音频 CD 刻录'
      : !caps!.ffmpeg.available
        ? '未找到可用的 ffmpeg，无法转码音频 CD'
        : !audioFits
          ? `总时长约 ${Math.ceil(options.totalDuration / 60)} 分钟，超出音频 CD 上限（约 ${Math.round(AUDIO_CD_MAX_SECONDS / 60)} 分钟）`
          : null
    : null

  const startDisabled =
    dist === 'physical' &&
    (physicalReason !== null ||
      (discType === 'data' && dataReason !== null) ||
      (discType === 'audio' && audioReason !== null))

  const confirm = () => {
    if (dist === 'digital') settle({ distribution: 'digital' })
    else settle({ distribution: 'physical', discType })
  }

  const capsLine = capsLoading
    ? '正在检测刻录机…'
    : caps && recorderCount > 0
      ? `刻录机 ${recorderCount} 台 · ${
          caps.media.present
            ? caps.media.blank
              ? `${caps.media.profile ?? '可写介质'} 已就绪`
              : '介质不可写'
            : '未放盘'
        }`
      : '未检测到刻录机'

  return (
    <div
      className="rip-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`翻录 ${options.name}`}
    >
      <div
        className="rip-dialog__scrim"
        onClick={() => settle(null)}
        aria-hidden
      />
      <div className="rip-dialog__card">
        <h2 className="rip-dialog__title">翻录「{options.name}」</h2>
        <p className="rip-dialog__summary">
          {options.trackCount} 首
          {options.totalDuration > 0 &&
            ` · 约 ${Math.round(options.totalDuration / 60)} 分钟`}
        </p>

        <div className="rip-dialog__section">
          <div
            className="rip-dialog__segmented"
            role="radiogroup"
            aria-label="分发方式"
          >
            <button
              type="button"
              role="radio"
              aria-checked={dist === 'digital'}
              data-testid="rip-dist-digital"
              className={`rip-dialog__seg-btn${dist === 'digital' ? ' rip-dialog__seg-btn--active' : ''}`}
              onClick={() => setDist('digital')}
            >
              后续将数字分发
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={dist === 'physical'}
              data-testid="rip-dist-physical"
              className={`rip-dialog__seg-btn${dist === 'physical' ? ' rip-dialog__seg-btn--active' : ''}`}
              onClick={() => setDist('physical')}
            >
              后续将实体分发
            </button>
          </div>
          <p className="rip-dialog__hint">
            {dist === 'digital'
              ? '打包为 ZIP 下载：音频文件 + 封面（若有）+ meta.json 元信息。'
              : '由后端直刻本机光驱：音频 + meta.json（数据 CD 一并上盘）。'}
          </p>
        </div>

        {dist === 'physical' && (
          <div className="rip-dialog__section">
            <div
              className="rip-dialog__segmented"
              role="radiogroup"
              aria-label="光盘类型"
            >
              <button
                type="button"
                role="radio"
                aria-checked={discType === 'data'}
                data-testid="rip-disc-data"
                className={`rip-dialog__seg-btn${discType === 'data' ? ' rip-dialog__seg-btn--active' : ''}`}
                onClick={() => setDiscType('data')}
              >
                数据 CD
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={discType === 'audio'}
                data-testid="rip-disc-audio"
                disabled={audioReason !== null}
                className={`rip-dialog__seg-btn${discType === 'audio' ? ' rip-dialog__seg-btn--active' : ''}`}
                onClick={() => setDiscType('audio')}
              >
                音频 CD
              </button>
            </div>
            <p className="rip-dialog__hint">
              {discType === 'data'
                ? '音频与 meta.json 原样写盘，任何电脑可读；受光盘容量限制。'
                : '标准 CD-DA：转码为 44.1kHz/16bit，老式 CD 机可放；单盘上限约 79 分钟。'}
            </p>

            <p className="rip-dialog__caps" data-testid="rip-caps">
              {capsLine}
              {loopback && (
                <button
                  type="button"
                  className="rip-dialog__redetect"
                  data-testid="rip-redetect"
                  disabled={capsLoading}
                  onClick={() => void loadCaps()}
                >
                  <RefreshCw size={12} aria-hidden />
                  重新检测
                </button>
              )}
            </p>

            {physicalReason && (
              <p className="rip-dialog__reason" data-testid="rip-reason">
                {physicalReason}
              </p>
            )}
            {dataReason && (
              <p className="rip-dialog__reason" data-testid="rip-data-reason">
                {dataReason}
              </p>
            )}
            {audioReason && (
              <p className="rip-dialog__reason" data-testid="rip-audio-reason">
                {audioReason}
              </p>
            )}

            <p className="rip-dialog__warning">
              <AlertTriangle size={14} aria-hidden />
              刻录会真实写入光盘且不可撤销，请确认光驱中放入的是空白盘。
            </p>
          </div>
        )}

        <div className="rip-dialog__actions">
          <button
            type="button"
            className="rip-dialog__btn rip-dialog__btn--ghost"
            onClick={() => settle(null)}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`rip-dialog__btn ${
              dist === 'physical'
                ? 'rip-dialog__btn--danger'
                : 'rip-dialog__btn--primary'
            }`}
            disabled={startDisabled}
            onClick={confirm}
          >
            {dist === 'physical' ? '开始刻录' : '开始翻录'}
          </button>
        </div>
      </div>
    </div>
  )
}
