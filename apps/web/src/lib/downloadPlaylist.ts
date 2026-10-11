import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import {
  streamUrlOf,
  type AudioLevel,
  type Track,
} from '@pterosaur/shared/types'
import {
  RIP_META_FILE,
  buildRipMeta,
  extFromImageMime,
  extFromMime,
  ripFileName,
  safeRipName,
  type RipMetaInput,
} from '@pterosaur/shared/rip'

/**
 * 拉取封面图片并以 `cover.<ext>` 写入 ZIP；成功时返回实际文件名（供 `meta.json` 引用），
 * 失败返回 null。
 *
 * 封面是网易云 CDN 上的公共静态资源、无条件返回 `access-control-allow-origin: *`
 * （图片直连的既有例外，见 ADR-013），故直接 `fetch` 取字节。任何失败都静默跳过——
 * 封面缺失不应让整次翻录失败。
 */
async function addCoverToZip(
  zip: JSZip,
  coverUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(coverUrl, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) return null
    const type = res.headers.get('content-type')
    if (!type || !type.startsWith('image/')) return null
    const blob = await res.blob()
    if (blob.size === 0) return null
    const name = `cover.${extFromImageMime(type)}`
    zip.file(name, blob)
    return name
  } catch {
    return null // 封面获取失败：忽略，仅缺封面文件
  }
}

export interface DownloadProgress {
  current: number
  total: number
  /** 最近一次失败的错误信息，成功时为 null。 */
  lastError: string | null
}

export interface DownloadPlaylistOptions {
  /**
   * 元信息素材；提供则在全部曲目处理完成后于 ZIP 根写入 `meta.json`（见 ADR-047）。
   * `tracks[].file` 以实际入包文件名回填，失败曲目记入 `skipped`。
   */
  metaInput?: RipMetaInput
}

/**
 * 将歌单 / 专辑曲目打包为 ZIP 下载。
 *
 * 逐首通过同源音频代理 `/stream/:id` 拉取字节流，文件名按序号排列
 * （如 `01 - 曲名.mp3`，命名工具见 `@pterosaur/shared/rip`），最终以 browser Blob 触发保存。
 * 若提供 `coverUrl`（专辑翻录），另在 ZIP 根目录写入封面 `cover.<ext>`。
 *
 * @param tracks  曲目列表
 * @param zipName  ZIP 文件名（不含扩展名）
 * @param onProgress  每完成/跳过一个曲目时回调
 * @param coverUrl  可选封面地址；提供则一并打包（获取失败不阻断）
 * @param level  音质档位；缺省时由后端兜底
 * @param opts  可选：`metaInput` 提供时写入 `meta.json`（含逐曲文件名与跳过清单）
 */
export async function downloadPlaylist(
  tracks: Track[],
  zipName: string,
  onProgress?: (p: DownloadProgress) => void,
  coverUrl?: string,
  level?: AudioLevel,
  opts?: DownloadPlaylistOptions,
): Promise<void> {
  const zip = new JSZip()

  // 封面先入包：即便后续曲目全部失败，封面仍在
  const coverFile = coverUrl ? await addCoverToZip(zip, coverUrl) : null

  /** 实际入包的曲目文件名：1 起序号 → 文件名（meta.json 回填用）。 */
  const files = new Map<number, string>()
  /** 拉取失败被跳过的曲目（meta.json 的 skipped 字段）。 */
  const skipped: { index: number; title: string; reason: string }[] = []

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    let blob: Blob | null = null
    let ext = 'mp3'

    try {
      const res = await fetch(streamUrlOf(t, level ? { level } : undefined), {
        credentials: 'include',
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      blob = await res.blob()
      ext = extFromMime(res.headers.get('content-type'))
    } catch (err) {
      // 单首失败跳过，继续打包其余曲目
      const reason = err instanceof Error ? err.message : '未知错误'
      skipped.push({ index: i + 1, title: t.title, reason })
      onProgress?.({
        current: i + 1,
        total: tracks.length,
        lastError: `${t.title}: ${reason}`,
      })
      continue
    }

    const name = ripFileName(i + 1, tracks.length, t.title, ext)
    files.set(i + 1, name)
    zip.file(name, blob)
    onProgress?.({ current: i + 1, total: tracks.length, lastError: null })
  }

  if (opts?.metaInput) {
    const meta = buildRipMeta(
      // 封面地址与入包参数同源：metaInput 未显式给出时回落到 `coverUrl`，避免调用方双写
      { ...opts.metaInput, coverUrl: opts.metaInput.coverUrl ?? coverUrl },
      tracks,
      {
        fileOf: (index) => files.get(index),
        coverFile: coverFile ?? undefined,
        skipped,
      },
    )
    zip.file(RIP_META_FILE, JSON.stringify(meta, null, 2))
  }

  const archive = await zip.generateAsync({ type: 'blob' })
  saveAs(archive, `${safeRipName(zipName)}.zip`)
}
