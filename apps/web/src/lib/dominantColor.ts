import { registerCacheCleaner } from './cacheRegistry.js'
import { canonicalNeteaseImage } from '@pterosaur/shared/image'

/**
 * 封面「代表色」取色。
 *
 * 做法：把封面绘到 32×32 的离屏 canvas → 按亮度加权统计 12 档色相（低饱和像素并入）。
 * 不用平均色——一张蓝底橙字的海报平均下来会是一团灰；改取「出现最多的那一档色相里的
 * 代表色」，更贴近 Apple Music 那种从封面里透出来的底色。
 *
 * 只需相对色相与相对明度，拆分逻辑放在 CSS `color-mix` 里（见 app.css 与 tokens.css 的 `--art-surface` 系列），
 * 深色 / 浅色主题共用同一个返回值。结果按**规范化 URL** 在内存里缓存（同一封面反复进出
 * 页面不重复取色），并登记到统一清缓存。
 *
 * 仅依赖 DOM（canvas / Image），无 DOM 环境或被 crossOrigin 拦下时返回 `null`。
 */

const BUCKETS = 12

interface Sample {
  /** 权重（像素数 × 亮度权重）。 */
  w: number
  r: number
  g: number
  b: number
}

const cache = new Map<string, string | null>()
const MAX = 256

function rgbToHex(r: number, g: number, b: number): string {
  const h = (x: number) =>
    Math.round(Math.min(255, Math.max(0, x)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** 从已加载的图片取代表色；失败返回 `null`。 */
function sample(img: HTMLImageElement): string | null {
  if (!img.naturalWidth || !img.naturalHeight) return null
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  let data: Uint8ClampedArray
  try {
    ctx.drawImage(img, 0, 0, size, size)
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    // 跨域图未带 CORS 头：画布被污染
    return null
  }

  const buckets: Sample[] = Array.from({ length: BUCKETS }, () => ({
    w: 0,
    r: 0,
    g: 0,
    b: 0,
  }))
  let grey: Sample = { w: 0, r: 0, g: 0, b: 0 }

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    // 亮度权重：近黑 / 近白的像素对底色感知贡献小（且常是边框、文字）
    const l = (max + min) / 510
    const w = 0.15 + 0.85 * Math.sin(Math.PI * Math.min(1, l * 1.1))
    const s = max === 0 ? 0 : d / max
    if (s < 0.12 || d === 0) {
      grey.w += w
      grey.r += r * w
      grey.g += g * w
      grey.b += b * w
      continue
    }
    let h = 0
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    if (h < 0) h += 6
    const k = Math.min(BUCKETS - 1, Math.floor((h / 6) * BUCKETS))
    const bucket = buckets[k]
    bucket.w += w
    bucket.r += r * w
    bucket.g += g * w
    bucket.b += b * w
  }

  let best: Sample | null = null
  for (const b of buckets) if (b.w > 0 && (!best || b.w > best.w)) best = b
  // 整张图都近乎无彩色：退回加权平均的灰，CSS 侧会因饱和度低而看不出色偏
  if (!best) best = grey.w > 0 ? grey : null
  if (!best) return null
  return rgbToHex(best.r / best.w, best.g / best.w, best.b / best.w)
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 封面 URL 均带 CORS 响应头（网易云 / B 站 CDN 皆然）；不带时画布被污染，返回 null 走兜底。
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

/** 取封面代表色（`#rrggbb`）；无 DOM、跨域受限或加载失败返回 `null`。 */
export async function dominantColor(url: string): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const key = canonicalNeteaseImage(url)
  if (cache.has(key)) return cache.get(key) ?? null
  let color: string | null = null
  try {
    color = sample(await load(url))
  } catch {
    color = null
  }
  cache.set(key, color)
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return color
}

/** 清空取色缓存（供测试 / 凭证切换清缓存）。 */
export function clearDominantColors(): void {
  cache.clear()
}

registerCacheCleaner(clearDominantColors)
