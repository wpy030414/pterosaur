import { describe, it, expect } from 'vitest'
import { parseLrc } from '../src/lyric.js'

describe('parseLrc', () => {
  it('解析基础带时间轴歌词', () => {
    const lrc = '[00:12.34]第一行\n[00:15.00]第二行'
    const r = parseLrc(lrc)
    expect(r.timed).toBe(true)
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toMatchObject({ time: 12.34, text: '第一行' })
    expect(r.lines[1]).toMatchObject({ time: 15, text: '第二行' })
  })

  it('支持一行多时间戳展开', () => {
    const lrc = '[00:01.00][00:05.00]副歌'
    const r = parseLrc(lrc)
    expect(r.lines).toHaveLength(2)
    expect(r.lines.map((l) => l.time)).toEqual([1, 5])
    expect(r.lines.every((l) => l.text === '副歌')).toBe(true)
  })

  it('按时间排序（乱序输入也稳定）', () => {
    const lrc = '[00:20.00]后\n[00:05.00]前\n[00:12.00]中'
    const r = parseLrc(lrc)
    expect(r.lines.map((l) => l.time)).toEqual([5, 12, 20])
    expect(r.lines.map((l) => l.text)).toEqual(['前', '中', '后'])
  })

  it('支持两位小数（厘秒）与三位小数（毫秒）', () => {
    const two = parseLrc('[01:30.55]x')
    expect(two.lines[0].time).toBeCloseTo(90.55, 5)
    const three = parseLrc('[01:30.550]x')
    expect(three.lines[0].time).toBeCloseTo(90.55, 5)
    const none = parseLrc('[01:30]x')
    expect(none.lines[0].time).toBe(90)
  })

  it('跳过元信息行（无正文）但保留时间轴为空文本', () => {
    const lrc = '[00:00.00] 作词 : 某人\n[00:05.00]正文'
    const r = parseLrc(lrc)
    // 两行都有时间戳，作词行文本被保留（由 UI 决定是否隐藏）
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0].text).toContain('作词')
    expect(r.lines[1].text).toBe('正文')
  })

  it('空输入返回非时间轴结果', () => {
    expect(parseLrc('')).toEqual({ lines: [], timed: false })
  })

  it('无时间戳的纯文本歌词 -> timed=false', () => {
    const r = parseLrc('这是一段没有时间轴的歌词\n第二行')
    expect(r.timed).toBe(false)
    expect(r.lines).toHaveLength(0)
  })

  it('合并翻译歌词（时间对齐）', () => {
    const lrc = '[00:10.00]Hello\n[00:14.00]World'
    const tlyric = '[00:10.00]你好\n[00:14.00]世界'
    const r = parseLrc(lrc, tlyric)
    expect(r.lines[0].translation).toBe('你好')
    expect(r.lines[1].translation).toBe('世界')
  })

  it('翻译缺失时对应行不带 translation', () => {
    const lrc = '[00:10.00]Hello\n[00:14.00]World'
    const tlyric = '[00:10.00]你好'
    const r = parseLrc(lrc, tlyric)
    expect(r.lines[0].translation).toBe('你好')
    expect(r.lines[1].translation).toBeUndefined()
  })

  it('容忍浮点误差的翻译对齐（±0.01s）', () => {
    const lrc = '[00:10.00]Hello'
    const tlyric = '[00:10.01]你好'
    const r = parseLrc(lrc, tlyric)
    expect(r.lines[0].translation).toBe('你好')
  })
})
