import type { Lyric, LyricLine } from './types.js'

/**
 * 解析单条时间戳为秒。支持 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`。
 */
function parseTimestamp(raw: string): number {
  // 形如 03:25.123 或 03:25
  const m = raw.match(/(\d+):(\d{1,2})(?:[.:](\d{1,3}))?/)
  if (!m) return NaN
  const min = Number(m[1]) || 0
  const sec = Number(m[2]) || 0
  const fracRaw = m[3] ?? ''
  // 归一化毫秒：2 位当作厘秒，3 位当作毫秒
  const frac =
    fracRaw === '' ? 0 : Number(fracRaw.padEnd(3, '0').slice(0, 3)) / 1000
  return min * 60 + sec + frac
}

/**
 * 解析 LRC 文本为若干 `{ time, text }`（不含翻译）。
 *
 * 支持一行多时间戳：`[00:01.00][00:05.00]文本` 会展开为两行。
 */
function parseLines(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  if (!lrc) return out
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const stamps = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])
    if (stamps.length === 0) continue
    // 去掉所有时间戳后剩余的即歌词正文
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    for (const s of stamps) {
      const time = parseTimestamp(s)
      if (Number.isNaN(time)) continue
      // 允许空文本（纯音乐间隔），但过滤纯元信息噪声由调用方决定
      out.push({ time, text })
    }
  }
  // 按时间排序，保证渲染与高亮顺序稳定
  out.sort((a, b) => a.time - b.time)
  return out
}

/**
 * 解析带翻译的 LRC。
 *
 * @param lrc 原文 LRC
 * @param tlyric 翻译 LRC（可选，时间轴与原文一致）
 */
export function parseLrc(lrc: string, tlyric?: string): Lyric {
  const lines = parseLines(lrc)
  const timed = lines.some((l) => l.text.length > 0)

  if (tlyric && lines.length) {
    const trans = parseLines(tlyric)
    if (trans.length) {
      // 以时间为键建立翻译索引（容差 0.05s，规避浮点误差）
      const byTime = new Map<number, string>()
      for (const t of trans) {
        if (t.text) byTime.set(Number(t.time.toFixed(2)), t.text)
      }
      for (const line of lines) {
        const key = Number(line.time.toFixed(2))
        const hit =
          byTime.get(key) ??
          byTime.get(Number((key + 0.01).toFixed(2))) ??
          byTime.get(Number((key - 0.01).toFixed(2)))
        if (hit) line.translation = hit
      }
    }
  }

  return { lines, timed }
}
