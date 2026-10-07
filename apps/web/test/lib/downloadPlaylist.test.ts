import { describe, expect, it } from 'vitest'
import { extFromImageMime } from '../../src/lib/downloadPlaylist.js'

describe('extFromImageMime', () => {
  it('按 Content-Type 推断封面扩展名', () => {
    expect(extFromImageMime('image/jpeg')).toBe('jpg')
    expect(extFromImageMime('image/jpg')).toBe('jpg')
    expect(extFromImageMime('image/png')).toBe('png')
    expect(extFromImageMime('image/webp')).toBe('webp')
    expect(extFromImageMime('image/gif')).toBe('gif')
    expect(extFromImageMime('image/avif')).toBe('avif')
  })

  it('缺失或非图片类型回退 jpg', () => {
    expect(extFromImageMime(null)).toBe('jpg')
    expect(extFromImageMime('application/octet-stream')).toBe('jpg')
  })
})
