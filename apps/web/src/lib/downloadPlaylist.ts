import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import {
  streamUrlOf,
  type AudioLevel,
  type Track,
} from '@pterosaur/shared/types'
import {
  extFromImageMime,
  extFromMime,
  ripFileName,
  safeRipName,
} from '@pterosaur/shared/rip'

/**
 * 拉取封面图片并以 `cover.<ext>` 写入 ZIP。
 *
 * 封面是网易云 CDN 上的公共静态资源、无条件返回 `access-control-allow-origin: *`
 * （图片直连的既有例外，见 ADR-013），故直接 `fetch` 取字节。任何失败都静默跳过——
 * 封面缺失不应让整次翻录失败。
 */
async function addCoverToZip(zip: JSZip, coverUrl: string): Promise<void> {
  try {
    const res = await fetch(coverUrl, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) return
    const type = res.headers.get('content-type')
    if (!type || !type.startsWith('image/')) return
    const blob = await res.blob()
    if (blob.size === 0) return
    zip.file(`cover.${extFromImageMime(type)}`, blob)
  } catch {
    /* 封面获取失败：忽略，仅缺封面文件 */
  }
}

export interface DownloadProgress {
  current: number
  total: number
  /** 最近一次失败的错误信息，成功时为 null。 */
  lastError: string | null
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
 */
export async function downloadPlaylist(
  tracks: Track[],
  zipName: string,
  onProgress?: (p: DownloadProgress) => void,
  coverUrl?: string,
  level?: AudioLevel,
): Promise<void> {
  const zip = new JSZip()

  // 封面先入包：即便后续曲目全部失败，封面仍在
  if (coverUrl) await addCoverToZip(zip, coverUrl)

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
      onProgress?.({
        current: i + 1,
        total: tracks.length,
        lastError: `${t.title}: ${err instanceof Error ? err.message : '未知错误'}`,
      })
      continue
    }

    zip.file(ripFileName(i + 1, tracks.length, t.title, ext), blob)
    onProgress?.({ current: i + 1, total: tracks.length, lastError: null })
  }

  const archive = await zip.generateAsync({ type: 'blob' })
  saveAs(archive, `${safeRipName(zipName)}.zip`)
}
