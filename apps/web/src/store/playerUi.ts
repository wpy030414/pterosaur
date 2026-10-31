import { create } from 'zustand'

/**
 * 播放相关的**纯 UI** 状态（不持久化）。
 *
 * 目前只有全屏播放页的开合。单列一个 store 是为了让可持久化的队列状态不被
 * 「开/关全屏」这类高频 UI 动作连带写入，也让订阅方（`NowPlayingLayer`）只依赖它。
 */
interface PlayerUiState {
  /** 是否展开全屏播放页。 */
  expanded: boolean
  setExpanded: (v: boolean) => void
}

export const usePlayerUi = create<PlayerUiState>()((set) => ({
  expanded: false,
  setExpanded: (v) => set({ expanded: v }),
}))
