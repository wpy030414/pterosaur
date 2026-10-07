import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCoverRegistry,
  isCoverReady,
  preloadCover,
  whenCoverReady,
} from '../../src/lib/imageCache.js'

/**
 * jsdom 不真正加载图片：用可控假 Image 替身——构造即登记，由测试手动触发
 * onload / onerror / decode 结果。
 */
const created: Array<{
  src: string
  onload: (() => void) | null
  onerror: (() => void) | null
  decode: () => Promise<void>
}> = []

class FakeImage {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  decode = () => Promise.resolve()
  constructor() {
    created.push(this as unknown as (typeof created)[number])
  }
}

beforeEach(() => {
  created.length = 0
  clearCoverRegistry()
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 最后一个被创建的假 Image（即最近一次 whenCoverReady 发起的加载）。 */
function lastImage() {
  return created[created.length - 1]
}

describe('whenCoverReady', () => {
  it('加载 + 解码成功 → resolve(true) 并登记就绪', async () => {
    const p = whenCoverReady('/a.jpg')
    expect(lastImage().src).toBe('/a.jpg')
    lastImage().onload!()
    await expect(p).resolves.toBe(true)
    expect(isCoverReady('/a.jpg')).toBe(true)
  })

  it('已登记的 URL 立即 resolve(true)，不再发起加载', async () => {
    const first = whenCoverReady('/cached.jpg')
    lastImage().onload!()
    await first
    const createdAfterLoad = created.length
    await expect(whenCoverReady('/cached.jpg')).resolves.toBe(true)
    expect(created.length).toBe(createdAfterLoad)
  })

  it('加载失败（onerror）→ resolve(false) 且不登记', async () => {
    const p = whenCoverReady('/bad.jpg')
    lastImage().onerror!()
    await expect(p).resolves.toBe(false)
    expect(isCoverReady('/bad.jpg')).toBe(false)
  })

  it('解码失败 → 同样视为未就绪', async () => {
    const p = whenCoverReady('/decode-fail.jpg')
    const img = lastImage()
    img.decode = () => Promise.reject(new Error('decode failed'))
    img.onload!()
    await expect(p).resolves.toBe(false)
    expect(isCoverReady('/decode-fail.jpg')).toBe(false)
  })

  it('同一 URL 并发等待共享一次加载', async () => {
    const p1 = whenCoverReady('/dedup.jpg')
    const p2 = whenCoverReady('/dedup.jpg')
    expect(created.length).toBe(1)
    lastImage().onload!()
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
  })

  it('preloadCover 失败时静默（不抛错、不登记）', async () => {
    preloadCover('/preload-bad.jpg')
    lastImage().onerror!()
    // 冲刷微任务，确认无未处理拒绝
    await Promise.resolve()
    expect(isCoverReady('/preload-bad.jpg')).toBe(false)
  })

  it('登记键经规范化：不同镜像主机的同一封面互相命中', async () => {
    const p1 = whenCoverReady(
      'https://p1.music.126.net/h==/1.jpg?param=600y600',
    )
    expect(lastImage().src).toBe(
      'https://p1.music.126.net/h==/1.jpg?param=600y600',
    )
    lastImage().onload!()
    await p1

    // 换一个轮换到的镜像主机查询：应视为已就绪，且不再发起新加载
    const createdBefore = created.length
    await expect(
      whenCoverReady('http://p4.music.126.net/h==/1.jpg?param=600y600'),
    ).resolves.toBe(true)
    expect(created.length).toBe(createdBefore)
    expect(
      isCoverReady('https://p9.music.126.net/h==/1.jpg?param=600y600'),
    ).toBe(true)
  })
})
