import { create } from 'zustand'
import type { RipPhase } from '@pterosaur/shared/rip'

/**
 * 翻录（打包下载 / 本机刻录）的**全局**进度状态。
 *
 * 放在全局 store 而非页面局部 state —— 翻录是后台进行的长任务，切换页面不该丢失进度；
 * 页面只按 `job.key` 认领属于自己的那份，**重进视图即自动恢复环形进度**。
 * 不持久化：整页刷新会中止后台下载，届时状态本就该归零。
 *
 * `phase` 描述所处阶段（见 ADR-047/048）：数字分发恒为 `fetch`；实体刻录链路依次
 * `fetch`（拉取音频）→ `convert`（音频 CD 转码）→ `burn`（写入光盘）。
 */
export interface RipJob {
  /** 正在翻录的合集标识：`playlist:<source>:<id>` / `album:<source>:<id>` / `favorites`。 */
  key: string
  /** 当前阶段。 */
  phase: RipPhase
  /** 已处理曲目数（fetch / convert 阶段）。 */
  current: number
  /** 总曲目数。 */
  total: number
  /**
   * 阶段百分比。**刻录阶段恒为 null**——IMAPI 拿不到真实写入百分比（见 ADR-048），
   * 界面渲染不确定进度；其余阶段暂不使用，保持 null。
   */
  percent: number | null
}

interface RipState {
  /** 当前翻录任务；`null` 表示空闲。全局同一时刻至多一个。 */
  job: RipJob | null
  start: (key: string, total: number) => void
  setPhase: (phase: RipPhase) => void
  setProgress: (current: number, total: number) => void
  setPercent: (percent: number | null) => void
  finish: () => void
}

export const useRip = create<RipState>()((set, get) => ({
  job: null,
  start: (key, total) =>
    set({ job: { key, phase: 'fetch', current: 0, total, percent: null } }),
  setPhase: (phase) => {
    const job = get().job
    if (job) set({ job: { ...job, phase } })
  },
  setProgress: (current, total) => {
    const job = get().job
    if (job) set({ job: { ...job, current, total } })
  },
  setPercent: (percent) => {
    const job = get().job
    if (job) set({ job: { ...job, percent } })
  },
  finish: () => set({ job: null }),
}))
