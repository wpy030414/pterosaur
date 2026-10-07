import { describe, expect, it } from 'vitest'
import { formatBytes } from '../../src/lib/formatBytes.js'

describe('formatBytes', () => {
  it('零 / 非法输入 → 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('字节级不带小数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('进位到 KB / MB / GB 并保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1572864)).toBe('1.5 MB')
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GB')
  })
})
