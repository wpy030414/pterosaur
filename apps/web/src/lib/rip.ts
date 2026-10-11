import { saveAs } from 'file-saver'
import type { AudioLevel, MusicSource, Track } from '@pterosaur/shared/types'
import { DEFAULT_AUDIO_LEVEL } from '@pterosaur/shared/types'
import {
  RIP_META_FILE,
  type RipChoice,
  type RipKind,
  type RipMetaInput,
} from '@pterosaur/shared/rip'
import { burnPlaylist } from './burn.js'
import { downloadPlaylist } from './downloadPlaylist.js'
import { confirmDialog } from '../store/ui.js'
import { useRip } from '../store/rip.js'

/** 是否有翻录正在进行（全局同一时刻至多一个）。 */
export function isRipping(): boolean {
  return useRip.getState().job !== null
}

/** {@link runRip} 的合集描述（除分发方式外，两种产出共用的素材）。 */
export interface RunRipMeta {
  kind: RipKind
  /** 合集名（对话框标题与产物命名）。 */
  name: string
  /** 合集所属源；跨源合集（如混合收藏）缺省。 */
  source?: MusicSource
  /** 源内合集 id（`favorites` 无）。 */
  sourceId?: string
  /** 歌单作者 / 磁带 UP 主等（若有）。 */
  creator?: string
}

export interface RunRipOptions {
  /** 合集标识，与页面的 `RipJob.key` 对应。 */
  key: string
  tracks: Track[]
  meta: RunRipMeta
  /** 可选封面地址（专辑翻录）。 */
  coverUrl?: string
  /** 音质档位；缺省时由后端兜底。 */
  level?: AudioLevel
  /** 用户在翻录对话框中选择的产出方式（见 ADR-047）。 */
  choice: RipChoice
}

/**
 * 启动一次翻录（全局单任务），按用户所选**分发方式**分流（见 ADR-047/048）：
 *
 * - `digital`：浏览器 JSZip 打包下载（音频 + 封面 + `meta.json`），沿既有前台链路；
 * - `physical`：后端直刻本机光驱（仅同机访问开放），进度经 SSE 回传；刻录成功后
 *   浏览器另存一份 `meta.json`（数据 CD 已随盘上盘，音频 CD 无文件系统）。
 *
 * 进度写入 {@link useRip} 全局 store，因此**切换页面再回来仍能恢复环形进度**；下载 / 刻录在后台继续，
 * 不随发起组件卸载而中止。若已有翻录未结束，直接忽略本次调用（避免并发翻录）。
 * 失败统一在此弹出提示（数字链路的单曲失败在包内记为 `skipped`，不打断整包）。
 */
export async function runRip(opts: RunRipOptions): Promise<void> {
  if (useRip.getState().job) return
  useRip.getState().start(opts.key, opts.tracks.length)
  const level = opts.level ?? DEFAULT_AUDIO_LEVEL
  try {
    if (opts.choice.distribution === 'digital') {
      const metaInput: RipMetaInput = {
        distribution: 'digital',
        kind: opts.meta.kind,
        name: opts.meta.name,
        source: opts.meta.source,
        sourceId: opts.meta.sourceId,
        creator: opts.meta.creator,
        coverUrl: opts.coverUrl,
        level,
      }
      await downloadPlaylist(
        opts.tracks,
        opts.meta.name,
        (p) => useRip.getState().setProgress(p.current, p.total),
        opts.coverUrl,
        opts.level,
        { metaInput },
      )
    } else {
      const metaInput: RipMetaInput = {
        distribution: 'physical',
        discType: opts.choice.discType,
        kind: opts.meta.kind,
        name: opts.meta.name,
        source: opts.meta.source,
        sourceId: opts.meta.sourceId,
        creator: opts.meta.creator,
        coverUrl: opts.coverUrl,
        level,
      }
      const meta = await burnPlaylist(
        {
          tracks: opts.tracks,
          meta: metaInput,
          discType: opts.choice.discType,
          level,
        },
        (p) => {
          useRip.getState().setPhase(p.phase)
          useRip.getState().setProgress(p.current, p.total)
          useRip.getState().setPercent(p.percent)
        },
      )
      // 刻录成功：另存 meta.json（浏览器下载一份，与「两种方式产物都含 meta.json」对齐）
      saveAs(
        new Blob([JSON.stringify(meta, null, 2)], {
          type: 'application/json',
        }),
        RIP_META_FILE,
      )
    }
  } catch (err) {
    await confirmDialog({
      title: opts.choice.distribution === 'physical' ? '刻录失败' : '翻录失败',
      message: err instanceof Error ? err.message : '未知错误',
      confirmText: '知道了',
      cancelText: '关闭',
    })
  } finally {
    useRip.getState().finish()
  }
}
