import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_AUDIO_LEVEL, type AudioLevel } from '@pterosaur/shared/types'

/**
 * 应用偏好（本地持久化）。
 *
 * - **音质档位**：统一抽象档（见 shared `AudioLevel`），随 `/stream` 请求以 `?level=` 携带。
 * - **背景**：用户自定义的应用背景（图片 / 动图 / 视频）。**媒体本体存 IndexedDB**
 *   （见 `lib/background.ts`，避开 localStorage 的 ~5MB 配额），此处只留轻量元数据。
 */
export interface BackgroundConfig {
  kind: 'image' | 'video'
  /** 原始媒体类型（用于回放时判断，以及个别浏览器的兼容处理）。 */
  mime: string
  /** 从背景取出的主题色（base，十六进制如 `#3b6ea5`），用于替换默认强调色。 */
  accent: string
}

interface SettingsState {
  /** 音质档位（抽象档，跨源一致）。 */
  level: AudioLevel
  /** 自定义应用背景；`null` 表示未设置（用默认纯色背景）。 */
  background: BackgroundConfig | null
}

interface SettingsActions {
  setLevel: (level: AudioLevel) => void
  setBackground: (background: BackgroundConfig | null) => void
}

export type SettingsStore = SettingsState & SettingsActions

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      level: DEFAULT_AUDIO_LEVEL,
      background: null,
      setLevel: (level) => set({ level }),
      setBackground: (background) => set({ background }),
    }),
    {
      name: 'pterosaur-settings',
      partialize: (s) => ({ level: s.level, background: s.background }),
    },
  ),
)
