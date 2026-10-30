import { describe, it, expect } from 'vitest'
import {
  canonicalNeteaseImage,
  coverAt,
  COVER_RIP,
  NETEASE_IMAGE_HOST,
} from '../src/image.js'

/**
 * 实测样本（2026-10，curl 直连 p3.music.126.net）：某歌单封面地址上的完整图片处理参数串。
 * 原样请求返回 `400 {"Code":"InvalidArgument"}`；同一路径去掉查询串返回 200 原图。
 */
const BROKEN_PLAYLIST_QUERY =
  '?imageView=1&thumbnail=800y800&enlarge=1%7CimageView%3D1&watermark=&type=1' +
  '&image=' +
  'b2JqL3c1bkRrTUtRd3JMRGpEekNtOE9tLzc4NjI2NzcxNDMyL2I3MmEvMjAyNjEyNjEwMzYzL3g5NTkxNzcyMDczMzYzNzczLnBuZw%3D%3D' +
  '&dx=0&dy=0%7Cwatermark&type=1&image=' +
  'b2JqL3dvbkRsc0tVd3JMQ2xHakNtOEt4LzI3NjEwNDk3MDYyL2VlOTMvOTIxYS82NjE4LzdhMDc5ZDg0NTYyMDAwZmVkZWJmMjVjYjE4NjhkOWEzLnBuZw%3D%3D' +
  '&dx=0&dy=0%7CimageView%3D1&param=1200x1200'
const BROKEN_PLAYLIST_PATH = '/CYk4-t7JY7VvqUQBv6uJhw==/109951173991239425.jpg'

describe('canonicalNeteaseImage', () => {
  it('http → https', () => {
    expect(canonicalNeteaseImage('http://p3.music.126.net/a/b.jpg')).toBe(
      'https://p3.music.126.net/a/b.jpg',
    )
  })

  it('轮换镜像主机（p1/p4）统一到固定主机；裸域 music.126.net 不动（非实测镜像）', () => {
    expect(
      canonicalNeteaseImage('https://p1.music.126.net/h==/1.jpg?param=600y600'),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`)
    expect(
      canonicalNeteaseImage('https://p4.music.126.net/h==/1.jpg?param=600y600'),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`)
    expect(canonicalNeteaseImage('https://music.126.net/h==/1.jpg')).toBe(
      'https://music.126.net/h==/1.jpg',
    )
  })

  it('已是规范形式时原样返回', () => {
    const url = `https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`
    expect(canonicalNeteaseImage(url)).toBe(url)
  })

  it('多个 param 只保留最后一个（同图同尺寸唯一键）', () => {
    expect(
      canonicalNeteaseImage(
        'https://p1.music.126.net/h==/1.jpg?param=200y200&param=600y600',
      ),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`)
  })

  it('查询串白名单：param 以外的参数一律丢弃（imageView/enlarge/watermark 等）', () => {
    expect(
      canonicalNeteaseImage(
        'https://p1.music.126.net/h==/1.jpg?x=1&param=600y600',
      ),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`)
    expect(
      canonicalNeteaseImage(
        'https://p1.music.126.net/h==/1.jpg?imageView=1&thumbnail=800y800&param=600y600',
      ),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=600y600`)
  })

  it('只剩处理参数时丢弃全部查询串（CDN 对 imageView + 有效 enlarge 回 400）', () => {
    expect(
      canonicalNeteaseImage(
        `https://p3.music.126.net${BROKEN_PLAYLIST_PATH}?imageView=1&enlarge=2`,
      ),
    ).toBe(`https://${NETEASE_IMAGE_HOST}${BROKEN_PLAYLIST_PATH}`)
  })

  it('实测 400 的歌单封面：规范化后只剩 path + 单一 param（回归样本）', () => {
    const url = `https://p3.music.126.net${BROKEN_PLAYLIST_PATH}${BROKEN_PLAYLIST_QUERY}`
    const canonical = canonicalNeteaseImage(url)
    expect(canonical).toBe(
      `https://${NETEASE_IMAGE_HOST}${BROKEN_PLAYLIST_PATH}?param=1200x1200`,
    )
    // 不再残留任何触发 400 的组合
    const q = new URL(canonical).searchParams
    expect(q.getAll('imageView')).toEqual([])
    expect(q.getAll('enlarge')).toEqual([])
    expect(q.getAll('watermark')).toEqual([])
    expect(q.getAll('param')).toEqual(['1200x1200'])
  })

  it('同一封面带不同水印参数串，规范化后落同一个键（缓存不碎片化）', () => {
    const a = `https://p3.music.126.net${BROKEN_PLAYLIST_PATH}?imageView=1&enlarge=2&param=600y600`
    const b = `https://p1.music.126.net${BROKEN_PLAYLIST_PATH}?watermark=&param=600y600`
    expect(canonicalNeteaseImage(a)).toBe(canonicalNeteaseImage(b))
  })

  it('非网易云地址原样返回（不猜测其它 CDN 行为）', () => {
    const url = 'http://img.example.com/a.jpg?param=1'
    expect(canonicalNeteaseImage(url)).toBe(url)
  })

  it('空串与无法解析的输入原样返回', () => {
    expect(canonicalNeteaseImage('')).toBe('')
    expect(canonicalNeteaseImage('not a url')).toBe('not a url')
  })
})

describe('coverAt（按场景选尺寸）', () => {
  it('网易云：规范化镜像主机并设置 param 尺寸（覆盖原尺寸）', () => {
    expect(
      coverAt('https://p1.music.126.net/h==/1.jpg?param=600y600', 300),
    ).toBe(`https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=300x300`)
  })

  it('实测 400 的歌单封面：coverAt 产出可直接请求的地址（只含 path + param）', () => {
    expect(
      coverAt(
        `https://p3.music.126.net${BROKEN_PLAYLIST_PATH}${BROKEN_PLAYLIST_QUERY}`,
        300,
      ),
    ).toBe(`https://${NETEASE_IMAGE_HOST}${BROKEN_PLAYLIST_PATH}?param=300x300`)
  })

  it('其它 CDN / 空值 / 非法地址原样返回（不猜测其 CDN 行为）', () => {
    expect(coverAt('https://img.example.com/a.jpg', 300)).toBe(
      'https://img.example.com/a.jpg',
    )
    expect(coverAt('', 300)).toBe('')
    expect(coverAt(undefined, 300)).toBeUndefined()
    expect(coverAt('not a url', 300)).toBe('not a url')
  })

  it('COVER_RIP 档（翻录封面，尽可能大）产出 param=3000x3000', () => {
    expect(COVER_RIP).toBe(3000) // 实测网易云母带上限，调大前先实测
    expect(coverAt('https://p3.music.126.net/h==/1.jpg', COVER_RIP)).toBe(
      `https://${NETEASE_IMAGE_HOST}/h==/1.jpg?param=3000x3000`,
    )
  })
})
