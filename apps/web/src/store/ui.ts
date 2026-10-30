import { create } from 'zustand'
import type { Track } from '@pterosaur/shared/types'
import type { RipChoice } from '@pterosaur/shared/rip'

/**
 * 临时 UI 状态（不持久化）：队列面板开合等。
 *
 * 与播放状态（player store）、资料库（library store）分离，
 * 避免浮层开合这类高频临时状态污染需要持久化的存储。
 */
interface UiState {
  /** 右侧播放队列面板是否打开。 */
  queueOpen: boolean
  toggleQueue: () => void
  setQueueOpen: (v: boolean) => void
}

export const useQueuePanel = create<UiState>()((set) => ({
  queueOpen: false,
  toggleQueue: () => set((s) => ({ queueOpen: !s.queueOpen })),
  setQueueOpen: (v) => set({ queueOpen: v }),
}))

/** 移动端侧边栏抽屉（≤768px 时替代常驻侧栏，由汉堡按钮触发）。 */
interface SidebarDrawerState {
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (v: boolean) => void
}

export const useSidebarDrawer = create<SidebarDrawerState>()((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
}))

/** 新建歌单弹窗的打开参数。 */
export interface CreatePlaylistOptions {
  /** 预置曲目（如从「添加到歌单」菜单发起时带入当前曲目）。 */
  tracks?: Track[]
  /** 创建成功回调，返回新歌单 ID（用于跳转）。 */
  onDone?: (id: string) => void
}

interface CreatePlaylistUiState {
  open: boolean
  tracks: Track[]
  onDone: ((id: string) => void) | null
  openCreate: (opts?: CreatePlaylistOptions) => void
  closeCreate: () => void
}

/**
 * 新建歌单弹窗的 UI 状态（全局单例，弹窗挂载在 App 顶层）。
 *
 * 取代原生 `window.prompt`，保持与登录弹窗一致的视觉风格。
 */
export const useCreatePlaylist = create<CreatePlaylistUiState>()((set) => ({
  open: false,
  tracks: [],
  onDone: null,
  openCreate: (opts) =>
    set({
      open: true,
      tracks: opts?.tracks ?? [],
      onDone: opts?.onDone ?? null,
    }),
  closeCreate: () => set({ open: false, tracks: [], onDone: null }),
}))

/** 确认弹窗的参数。 */
export interface ConfirmOptions {
  /** 标题（主问句）。 */
  title: string
  /** 补充说明（可选）。 */
  message?: string
  /** 确认按钮文案，默认「确定」。 */
  confirmText?: string
  /** 取消按钮文案，默认「取消」。 */
  cancelText?: string
  /** 是否为危险操作（确认按钮用强调/警示色）。 */
  danger?: boolean
}

interface ConfirmUiState {
  open: boolean
  options: ConfirmOptions
  /** 内部：当前挂起的 Promise resolve，供弹窗关闭时回填结果。 */
  resolve: ((value: boolean) => void) | null
  /**
   * 打开确认弹窗，返回用户选择的 Promise（true 确认 / false 取消）。
   *
   * 取代原生 `window.confirm`，调用方可 `if (await confirmDialog({...})) ...`。
   */
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  /** 结束弹窗并回填结果。 */
  settle: (value: boolean) => void
}

const DEFAULT_CONFIRM: ConfirmOptions = { title: '' }

/**
 * 全局确认弹窗的 UI 状态（弹窗挂载在 App 顶层）。
 */
export const useConfirmDialog = create<ConfirmUiState>()((set, get) => ({
  open: false,
  options: DEFAULT_CONFIRM,
  resolve: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      // 若已有挂起的确认，先以「取消」结清，避免 Promise 泄漏
      get().resolve?.(false)
      set({ open: true, options: opts, resolve })
    }),
  settle: (value) => {
    get().resolve?.(value)
    set({ open: false, options: DEFAULT_CONFIRM, resolve: null })
  },
}))

/**
 * 打开确认弹窗的命令式入口（取代 `window.confirm`）。
 *
 * @example
 * if (await confirmDialog({ title: '删除歌单？', danger: true })) { ... }
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmDialog.getState().confirm(opts)
}

/** 翻录方式选择弹窗的参数（合集级摘要信息）。 */
export interface RipDialogOptions {
  /** 合集名（标题与产物命名）。 */
  name: string
  /** 曲目数。 */
  trackCount: number
  /** 曲目总时长（秒），供音频 CD 容量预检。 */
  totalDuration: number
  /** 曲目是否跨多个音源（跨源合集无法由后端直刻，见 ADR-048）。 */
  mixedSources?: boolean
}

interface RipDialogUiState {
  open: boolean
  options: RipDialogOptions | null
  /** 内部：当前挂起的 Promise resolve，供弹窗关闭时回填选择结果。 */
  resolve: ((value: RipChoice | null) => void) | null
  /**
   * 打开翻录方式弹窗，返回用户选择（数字 / 实体 + 光盘类型），取消返回 null。
   *
   * 取代三页原先的 `confirmDialog({ title: '翻录…' })` 纯确认——
   * 「后续将数字分发 / 后续将实体分发」在弹窗内一并选定。
   */
  openRip: (opts: RipDialogOptions) => Promise<RipChoice | null>
  /** 结束弹窗并回填结果。 */
  settle: (value: RipChoice | null) => void
}

/**
 * 翻录方式选择弹窗的 UI 状态（弹窗挂载在 App 顶层）。
 */
export const useRipDialog = create<RipDialogUiState>()((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  openRip: (opts) =>
    new Promise<RipChoice | null>((resolve) => {
      // 若已有挂起的弹窗，先以「取消」结清，避免 Promise 泄漏（与 confirmDialog 同策略）
      get().resolve?.(null)
      set({ open: true, options: opts, resolve })
    }),
  settle: (value) => {
    get().resolve?.(value)
    set({ open: false, options: null, resolve: null })
  },
}))

/**
 * 打开翻录方式弹窗的命令式入口。
 *
 * @example
 * const choice = await ripDialog({ name, trackCount, totalDuration })
 * if (choice) await runRip({ ..., choice })
 */
export function ripDialog(opts: RipDialogOptions): Promise<RipChoice | null> {
  return useRipDialog.getState().openRip(opts)
}

/** 设置弹窗（缓存管理 / 检查更新）的开合状态。 */
interface SettingsDialogState {
  open: boolean
  openSettings: () => void
  closeSettings: () => void
}

/**
 * 设置弹窗的 UI 状态（弹窗挂载在 App 顶层，由顶栏齿轮按钮打开）。
 */
export const useSettingsDialog = create<SettingsDialogState>()((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
}))
