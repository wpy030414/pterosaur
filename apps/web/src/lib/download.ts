import {
  streamUrlOf,
  type AudioLevel,
  type Track,
} from '@pterosaur/shared/types'
import { extFromMime, safeRipName } from '@pterosaur/shared/rip'

/**
 * 把一段已取到的字节存成本机文件（浏览器下载）。
 *
 * 与 {@link downloadTrack} 分开：离线保存的「导出」直接持有 blob，不必再走一次网络
 * （断网时也能导出）；文件名规则与下载一致。
 */
export function saveBlobAsFile(track: Track, blob: Blob, mime: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileName(track, extFromMime(mime))
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟释放，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 将曲目名清洗为安全的文件名（命名工具与翻录共用，见 `@pterosaur/shared/rip`）。 */
function safeFileName(track: Track, ext: string): string {
  return `${safeRipName(`${track.title} - ${track.artist}`)}.${ext}`
}

/**
 * 将曲目下载到本地。
 *
 * 走同源音频代理 `/stream/:id` 拉取完整字节流（携带登录 cookie，
 * 因此 VIP 曲目在登录后同样可下载），再以 Blob 触发浏览器保存。
 *
 * @throws 拉取失败或音源不可用（如未登录的 VIP 曲目）时抛出错误。
 */
export async function downloadTrack(
  track: Track,
  level?: AudioLevel,
): Promise<void> {
  const res = await fetch(streamUrlOf(track, level ? { level } : undefined), {
    credentials: 'include',
  })
  if (!res.ok) {
    const needLogin = res.status === 403
    throw new Error(
      needLogin ? '该曲目暂不可下载' : `下载失败（${res.status}）`,
    )
  }
  saveBlobAsFile(track, await res.blob(), res.headers.get('content-type') ?? '')
}
