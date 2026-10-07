import { create } from 'zustand'
import type { LoginStatus, MusicSource } from '@pterosaur/shared/types'
import {
  ALL_SOURCES,
  MUSIC_SOURCES,
  DEFAULT_SOURCE,
} from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { clearAllAppCaches } from '../lib/clearCaches.js'
import { useSync } from './sync.js'

interface AuthState {
  /** 各源各自的登录态（无源的浏览器会话互不影响）。 */
  status: Record<MusicSource, LoginStatus>
  /** 各源是否已向后端查询过登录态（避免闪烁）。 */
  loaded: Record<MusicSource, boolean>
  /** 登录弹窗是否打开。 */
  modalOpen: boolean
  /** 弹窗打开时落在哪个源 tab。 */
  modalSource: MusicSource
  /** 登录中的临时错误提示。 */
  error: string | null
}

interface AuthActions {
  /** 刷新登录态；不传源则刷新全部。 */
  refresh: (source?: MusicSource) => Promise<void>
  openModal: (source?: MusicSource) => void
  closeModal: () => void
  logout: (source: MusicSource) => Promise<void>
  setError: (msg: string | null) => void
}

export type AuthStore = AuthState & AuthActions

/** 生成「每源一份」的全假登录态 / 加载态（含磁带渠道，故遍历 `ALL_SOURCES`）。 */
const emptyStatus = (): Record<MusicSource, LoginStatus> =>
  Object.fromEntries(ALL_SOURCES.map((s) => [s, { logged: false }])) as Record<
    MusicSource,
    LoginStatus
  >
const emptyLoaded = (): Record<MusicSource, boolean> =>
  Object.fromEntries(ALL_SOURCES.map((s) => [s, false])) as Record<
    MusicSource,
    boolean
  >

export const useAuth = create<AuthStore>()((set) => ({
  status: emptyStatus(),
  loaded: emptyLoaded(),
  modalOpen: false,
  modalSource: DEFAULT_SOURCE,
  error: null,

  refresh: async (source) => {
    const targets = source ? [source] : [...ALL_SOURCES]
    await Promise.all(
      targets.map(async (s) => {
        let st: LoginStatus = { logged: false }
        try {
          st = await api.authStatus(s)
        } catch {
          st = { logged: false }
        }
        set((state) => ({
          status: { ...state.status, [s]: st },
          loaded: { ...state.loaded, [s]: true },
        }))
      }),
    )
  },

  openModal: (source) =>
    set({
      modalOpen: true,
      modalSource: source ?? DEFAULT_SOURCE,
      error: null,
    }),
  closeModal: () => set({ modalOpen: false, error: null }),

  logout: async (source) => {
    try {
      await api.logout(source)
    } finally {
      set((state) => ({
        status: {
          ...state.status,
          // 退出只清「已登录」，**必须保留 `loginable`**：否则该源会从登录弹窗的源 tab 列表里
          // 消失（弹窗按 loginable 过滤），表现为「退出后不刷新页面就再也登不回同一个源」。
          [source]: {
            logged: false,
            loginable: state.status[source]?.loginable,
          },
        },
      }))
      // 凭证已变更：清空全部缓存，避免旧（匿名时缓存的）媒体被复用（见 lib/clearCaches）
      void clearAllAppCaches()
    }
  },

  setError: (msg) => set({ error: msg }),
}))

/** 手机号+密码登录已不受支持——登录一律走扫码。 */

/** 扫码登录成功后写入该源登录态并关闭弹窗，并清空全部缓存（凭证已变更）。 */
export function finishQrLogin(source: MusicSource, status: LoginStatus): void {
  applyLogin(source, status)
  // 登录后**默认开启云同步**并绑定该账号；active 翻真即触发一次「云端权威」同步（见 useLibrarySync）。
  if (status.userId) useSync.getState().enable(source, status.userId)
  void clearAllAppCaches()
}

/** 写入某源登录态、关闭登录弹窗、清空错误。 */
function applyLogin(source: MusicSource, status: LoginStatus): void {
  useAuth.setState((state) => ({
    status: { ...state.status, [source]: status },
    loaded: { ...state.loaded, [source]: true },
    modalOpen: false,
    error: null,
  }))
}

/** 是否任一源已登录（含磁带渠道）。 */
export function isLoggedAny(status: Record<MusicSource, LoginStatus>): boolean {
  return ALL_SOURCES.some((s) => status[s]?.logged)
}

/**
 * 当前**活动账号**——最多一个源登录（单活动账号，见 ADR-027）；未登录返回 `null`。
 *
 * **含磁带渠道（B 站）**：登录它同样是「一个账号」，故顶栏账户菜单与**云同步锚点**都跟随它。
 * 需要「可浏览内容」的页面请改用 {@link activeMusicSource}。
 */
export function activeSource(
  status: Record<MusicSource, LoginStatus>,
): MusicSource | null {
  for (const s of ALL_SOURCES) if (status[s]?.logged) return s
  return null
}

/**
 * 当前**活动音乐源**（仅 `MUSIC_SOURCES`，现为网易云）；无则 `null`。
 *
 * 供「可浏览内容」的页面（首页 / 浏览 / 电台 / 搜索默认源）与源主题使用——它们需要发现 /
 * 歌单 / 排行榜等能力，而 磁带渠道（B 站）一概没有，故**不能**跟随 {@link activeSource}。
 */
export function activeMusicSource(
  status: Record<MusicSource, LoginStatus>,
): MusicSource | null {
  for (const s of MUSIC_SOURCES) if (status[s]?.logged) return s
  return null
}
