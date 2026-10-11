import { DiscAlbum } from 'lucide-react'
import type { RipPhase } from '@pterosaur/shared/rip'
import { IconButton } from './IconButton.js'
import './RipButton.css'

/** 翻录进度：已处理曲目数 / 总曲目数（+ 阶段）。 */
export interface RipProgress {
  current: number
  total: number
  /** 所处阶段；缺省视为 `fetch`（数字分发的既有形态）。 */
  phase?: RipPhase
  /**
   * 阶段百分比；仅刻录阶段有意义且恒为 `null`（不确定进度），保留字段以对齐事件协议。
   */
  percent?: number | null
}

interface RipButtonProps {
  /** 无曲目时置灰（仅在空闲态生效）。 */
  disabled?: boolean
  /** 进行中的进度；`null` 表示空闲，渲染「翻录」图标按钮。 */
  progress: RipProgress | null
  onClick: () => void
}

const RING_SIZE = 48
const RING_R = 20
const RING_STROKE = 3
/** 环周长，用于把进度换算成 dashoffset。 */
const CIRCUMFERENCE = 2 * Math.PI * RING_R

/**
 * 「翻录」按钮。
 *
 * 空闲时是下载图标按钮；进行中**就地**变为环形进度条，环内显示「已完成/总数」。
 * 实体刻录链路的 `convert` 阶段沿用真实进度；`burn` 阶段因拿不到真实百分比，
 * 渲染**不确定进度**（旋转弧 + 「刻录」）——详见 ADR-048。
 * 歌单 / 我喜欢的音乐 / 专辑三页共用，保证翻录反馈一致。
 */
export function RipButton({ disabled, progress, onClick }: RipButtonProps) {
  if (!progress) {
    return (
      <IconButton label="翻录" size="lg" onClick={onClick} disabled={disabled}>
        <DiscAlbum size={19} strokeWidth={2} />
      </IconButton>
    )
  }

  const phase = progress.phase ?? 'fetch'
  const burn = phase === 'burn'
  const total = Math.max(0, progress.total)
  const current = Math.min(Math.max(0, progress.current), total)
  const ratio = total > 0 ? current / total : 0
  const center = RING_SIZE / 2

  const label = burn
    ? '正在刻录光盘'
    : phase === 'convert'
      ? `正在转换音频 ${current} / ${total}`
      : `正在翻录 ${current} / ${total}`

  return (
    <div
      className="rip-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={burn ? undefined : current}
      aria-busy={burn || undefined}
      aria-label={label}
      title={label}
      data-testid="rip-progress"
      data-phase={phase}
    >
      <svg
        className="rip-progress__svg"
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        width={RING_SIZE}
        height={RING_SIZE}
        aria-hidden
      >
        <circle
          className="rip-progress__track"
          cx={center}
          cy={center}
          r={RING_R}
          fill="none"
          strokeWidth={RING_STROKE}
        />
        <circle
          className={`rip-progress__bar${burn ? ' rip-progress__bar--spin' : ''}`}
          cx={center}
          cy={center}
          r={RING_R}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={burn ? CIRCUMFERENCE * 0.3 : CIRCUMFERENCE}
          strokeDashoffset={burn ? 0 : CIRCUMFERENCE * (1 - ratio)}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="rip-progress__text">
        {burn ? '刻录' : `${current}/${total}`}
      </span>
    </div>
  )
}
