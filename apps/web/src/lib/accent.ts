/**
 * 从自定义背景取色并派生主题强调色（替换默认红 `--accent*`）。
 *
 * 做法：把图 / 视频首帧绘到离屏 canvas → 缩到 24×24 → 取平均色（跳过近透明像素）；
 * 再规整到「适合做强调色」的饱和度 / 明度区间（前景多为白字，故取中低明度、较高饱和）。
 *
 * 仅依赖 DOM（canvas / Image / video），无 DOM 环境（测试等）返回 `null`。
 */

/** 派生出的四个强调色变量值（直接写进 `--accent*`）。 */
export interface Accent {
  base: string
  hover: string
  press: string
  soft: string
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, l }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0xfa243c
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** 由一个 base 十六进制色派生四档强调色。 */
export function deriveAccent(hex: string): Accent {
  const rgb = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b)
  const S = clamp(s, 0.45, 0.92)
  const L = clamp(l, 0.42, 0.56)
  const pct = (x: number) => `${Math.round(clamp(x, 0, 1) * 100)}%`
  const H = Math.round(h)
  return {
    base: `hsl(${H} ${pct(S)} ${pct(L)})`,
    hover: `hsl(${H} ${pct(S)} ${pct(L + 0.08)})`,
    press: `hsl(${H} ${pct(S)} ${pct(L - 0.08)})`,
    soft: `hsl(${H} ${pct(S)} ${pct(L)} / 0.14)`,
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = url
    v.onloadeddata = () => resolve(v)
    v.onerror = () => reject(new Error('video load failed'))
  })
}

/** 把媒体首帧绘到小 canvas 取平均色，返回 `#rrggbb`（失败 / 无 canvas 返回 `null`）。 */
function sampleAverage(el: HTMLImageElement | HTMLVideoElement): string | null {
  const isVideo = typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement
  const w = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth
  const h = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight
  if (!w || !h) return null
  const size = 24
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    ctx.drawImage(el, 0, 0, size, size)
    const { data } = ctx.getImageData(0, 0, size, size)
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue // 跳过近透明像素
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      n++
    }
    if (!n) return null
    return rgbToHex(r / n, g / n, b / n)
  } catch {
    return null
  }
}

/**
 * 从背景媒体 blob 取平均色，返回 base 十六进制（`#rrggbb`）；无 DOM / 取色失败返回 `null`。
 * 派生四档强调色请用 {@link deriveAccent}（这样只需持久化一个 hex）。
 */
export async function accentFromBlob(blob: Blob): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  try {
    const source = blob.type.startsWith('video')
      ? await loadVideo(url)
      : await loadImage(url)
    return sampleAverage(source)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
