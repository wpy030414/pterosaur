import { describe, it, expect, beforeEach } from 'vitest'
import {
  usePlayer,
  advanceOnEnd,
  shuffledIndexes,
  currentPlayMode,
  audioSrc,
} from '../../src/store/player.js'
import { audioEl } from '../../src/hooks/audioElement.js'
import type { Track } from '@pterosaur/shared/types'

/** 构造测试用曲目。 */
function track(id: string, title = `曲目${id}`): Track {
  return {
    source: 'netease',
    id,
    title,
    artist: '艺人',
    album: '专辑',
    cover: '',
    duration: 100,
    fee: 'free',
  }
}

const SONGS = [track('1'), track('2'), track('3'), track('4'), track('5')]

/** 每个测试前重置 store 到初始态。 */
beforeEach(() => {
  usePlayer.setState({
    current: null,
    queue: [],
    index: -1,
    baseQueue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    repeat: 'all',
    shuffle: false,
    playError: null,
    playErrorNeedLogin: false,
    buffering: false,
    expanded: false,
  })
})

describe('audioSrc（音质档位）', () => {
  it('带档位时以 ?level= 形式拼入流地址', () => {
    expect(audioSrc(track('7'), 'lossless')).toBe(
      '/stream/netease/7?level=lossless',
    )
  })

  it('缺省档位时不带 level（由后端兜底）；空曲目返回空串', () => {
    expect(audioSrc(track('8'))).toBe('/stream/netease/8')
    expect(audioSrc(null)).toBe('')
  })
})

describe('播放错误与缓冲态', () => {
  it('setPlayError 记录错误文案与「是否需登录」标志', () => {
    usePlayer.getState().setPlayError('该曲目暂不可播放', true)
    expect(usePlayer.getState().playError).toBe('该曲目暂不可播放')
    expect(usePlayer.getState().playErrorNeedLogin).toBe(true)

    // 网络类错误：不需要登录入口
    usePlayer.getState().setPlayError('网络不稳定', false)
    expect(usePlayer.getState().playError).toBe('网络不稳定')
    expect(usePlayer.getState().playErrorNeedLogin).toBe(false)
  })

  it('setPlayError(null) 清除错误并复位登录标志', () => {
    usePlayer.getState().setPlayError('该曲目暂不可播放', true)
    usePlayer.getState().setPlayError(null)
    expect(usePlayer.getState().playError).toBeNull()
    expect(usePlayer.getState().playErrorNeedLogin).toBe(false)
  })

  it('setBuffering 切换缓冲态', () => {
    expect(usePlayer.getState().buffering).toBe(false)
    usePlayer.getState().setBuffering(true)
    expect(usePlayer.getState().buffering).toBe(true)
    usePlayer.getState().setBuffering(false)
    expect(usePlayer.getState().buffering).toBe(false)
  })
})

describe('advanceOnEnd（自然结束推进逻辑）', () => {
  it('repeat=one 停留在当前', () => {
    expect(advanceOnEnd(2, 5, 'one')).toBe(2)
  })

  it('repeat=all 中间曲目 -> 下一首', () => {
    expect(advanceOnEnd(2, 5, 'all')).toBe(3)
  })

  it('repeat=all 末尾 -> 回到 0', () => {
    expect(advanceOnEnd(4, 5, 'all')).toBe(0)
  })

  it('repeat=off 中间 -> 下一首', () => {
    expect(advanceOnEnd(2, 5, 'off')).toBe(3)
  })

  it('repeat=off 末尾 -> null（停止）', () => {
    expect(advanceOnEnd(4, 5, 'off')).toBeNull()
  })

  it('空队列 -> null', () => {
    expect(advanceOnEnd(0, 0, 'all')).toBeNull()
  })
})

describe('shuffledIndexes', () => {
  it('返回全部下标且不重不漏', () => {
    const idx = shuffledIndexes(5, 0)
    expect(idx).toHaveLength(5)
    expect([...idx].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('种子曲目排在首位', () => {
    const idx = shuffledIndexes(5, 3)
    expect(idx[0]).toBe(3)
  })
})

describe('usePlayer.playTracks', () => {
  it('以指定曲目为队列并从 startIndex 播放', () => {
    usePlayer.getState().playTracks(SONGS, 2)
    const s = usePlayer.getState()
    expect(s.queue).toHaveLength(5)
    expect(s.index).toBe(2)
    expect(s.current?.id).toBe('3')
    expect(s.isPlaying).toBe(true)
    expect(s.position).toBe(0)
  })

  it('startIndex 越界时收敛到合法范围', () => {
    usePlayer.getState().playTracks(SONGS, 99)
    expect(usePlayer.getState().index).toBe(4)
    usePlayer.getState().playTracks(SONGS, -5)
    expect(usePlayer.getState().index).toBe(0)
  })

  it('空数组不改变状态', () => {
    usePlayer.getState().playTracks([])
    expect(usePlayer.getState().current).toBeNull()
  })

  it('baseQueue 保存原始顺序', () => {
    usePlayer.getState().playTracks(SONGS, 0)
    expect(usePlayer.getState().baseQueue.map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
  })
})

describe('usePlayer.next / prev', () => {
  beforeEach(() => {
    usePlayer.getState().playTracks(SONGS, 0)
  })

  it('next 前进到下一首', () => {
    usePlayer.getState().next()
    expect(usePlayer.getState().current?.id).toBe('2')
    expect(usePlayer.getState().index).toBe(1)
  })

  it('repeat=all 时末尾 next 回到 0', () => {
    usePlayer.setState({ index: 4, current: SONGS[4] })
    usePlayer.getState().next()
    expect(usePlayer.getState().index).toBe(0)
  })

  it('repeat=off 时末尾 next 停止并标记已结束', () => {
    usePlayer.setState({ index: 4, current: SONGS[4], repeat: 'off' })
    usePlayer.getState().next()
    const s = usePlayer.getState()
    expect(s.index).toBe(4)
    expect(s.isPlaying).toBe(false)
    expect(s.position).toBe(0)
    expect(s.playbackEnded).toBe(true)
  })

  it('prev 回到上一首', () => {
    usePlayer.setState({ index: 2, current: SONGS[2], position: 0 })
    usePlayer.getState().prev()
    expect(usePlayer.getState().index).toBe(1)
  })

  it('position>3 时 prev 仅回到开头', () => {
    usePlayer.setState({ index: 2, current: SONGS[2], position: 30 })
    usePlayer.getState().prev()
    expect(usePlayer.getState().index).toBe(2)
    expect(usePlayer.getState().position).toBe(0)
  })

  it('position>3 时 prev 命令式回开头（驱动 audio.currentTime，防单向回写覆盖回归）', () => {
    // 回归背景：曾用 set({position:0}) 实现，但引擎每帧以 audio.currentTime
    // 回写 store.position，store 侧置 0 会被覆盖——点击表现为毫无反应。
    // prev 必须经 seekTo 真正拨动 audio.currentTime。
    const fake = { currentTime: 30, duration: 100 }
    audioEl.current = fake as unknown as HTMLAudioElement
    try {
      usePlayer.setState({ index: 2, current: SONGS[2], position: 30 })
      usePlayer.getState().prev()
      expect(fake.currentTime).toBe(0)
      expect(usePlayer.getState().position).toBe(0)
      expect(usePlayer.getState().index).toBe(2)
    } finally {
      audioEl.current = null
    }
  })

  it('开头 prev 回到末尾（repeat=all 语境）', () => {
    usePlayer.setState({ index: 0, current: SONGS[0], position: 0 })
    usePlayer.getState().prev()
    expect(usePlayer.getState().index).toBe(4)
  })
})

describe('usePlayer shuffle 顺序游走（无随机）', () => {
  // shuffle 只是把队列一次性重排；next/prev 应顺序游走（不再 Math.random），
  // 故这里全部读取 store 里的实际排列来断言，不依赖随机结果。
  beforeEach(() => {
    usePlayer.setState({ shuffle: true, repeat: 'all' })
    usePlayer.getState().playTracks(SONGS, 0)
  })

  it('next 走 index+1（按队列顺序，而非随机跳转）', () => {
    const q = usePlayer.getState().queue
    expect(q).toHaveLength(5)
    usePlayer.getState().next()
    expect(usePlayer.getState().index).toBe(1)
    expect(usePlayer.getState().current?.id).toBe(q[1].id)
  })

  it('连按 next 遍历整个排列且不重复，末尾回绕到 0', () => {
    const q = usePlayer.getState().queue
    const seen = [q[0].id]
    for (let i = 0; i < q.length - 1; i++) {
      usePlayer.getState().next()
      seen.push(usePlayer.getState().current?.id ?? '')
    }
    expect(seen).toEqual(q.map((t) => t.id))
    expect(new Set(seen).size).toBe(q.length)
    // 再按一次 → 回绕到队首
    usePlayer.getState().next()
    expect(usePlayer.getState().index).toBe(0)
  })

  it('prev 走 index-1，开头回绕到末尾', () => {
    const q = usePlayer.getState().queue
    usePlayer.setState({ index: 3, current: q[3], position: 0 })
    usePlayer.getState().prev()
    expect(usePlayer.getState().index).toBe(2)
    expect(usePlayer.getState().current?.id).toBe(q[2].id)

    usePlayer.setState({ index: 0, current: q[0], position: 0 })
    usePlayer.getState().prev()
    expect(usePlayer.getState().index).toBe(4)
  })

  it('末尾 next + repeat=off → 停止并标记已结束', () => {
    usePlayer.setState({ repeat: 'off' })
    usePlayer.setState({ index: 4, current: usePlayer.getState().queue[4] })
    usePlayer.getState().next()
    const s = usePlayer.getState()
    expect(s.index).toBe(4)
    expect(s.isPlaying).toBe(false)
    expect(s.playbackEnded).toBe(true)
  })

  it('末尾 next + repeat=one → 与 off 一致地停止（固化既有语义）', () => {
    usePlayer.setState({ repeat: 'one' })
    usePlayer.setState({ index: 4, current: usePlayer.getState().queue[4] })
    usePlayer.getState().next()
    const s = usePlayer.getState()
    expect(s.index).toBe(4)
    expect(s.isPlaying).toBe(false)
    expect(s.playbackEnded).toBe(true)
  })

  it('手动 next 与自然结束推进 advanceOnEnd 一致', () => {
    const len = usePlayer.getState().queue.length
    for (let i = 0; i < len; i++) {
      usePlayer.setState({
        index: i,
        current: usePlayer.getState().queue[i],
        position: 0,
      })
      usePlayer.getState().next()
      expect(usePlayer.getState().index).toBe(advanceOnEnd(i, len, 'all'))
    }
  })
})

describe('usePlayer 播放模式', () => {
  it('cycleRepeat 循环切换 off->all->one->off', () => {
    usePlayer.setState({ repeat: 'off' })
    usePlayer.getState().cycleRepeat()
    expect(usePlayer.getState().repeat).toBe('all')
    usePlayer.getState().cycleRepeat()
    expect(usePlayer.getState().repeat).toBe('one')
    usePlayer.getState().cycleRepeat()
    expect(usePlayer.getState().repeat).toBe('off')
  })

  it('toggleShuffle 开启后保持当前曲目并重排', () => {
    usePlayer.getState().playTracks(SONGS, 2)
    const currentId = usePlayer.getState().current?.id
    usePlayer.getState().toggleShuffle()
    const s = usePlayer.getState()
    expect(s.shuffle).toBe(true)
    // 当前曲目应排在打乱队列首位
    expect(s.queue[0].id).toBe(currentId)
    expect(s.queue).toHaveLength(5)
  })

  it('toggleShuffle 关闭后恢复原始顺序并保持当前曲目', () => {
    usePlayer.getState().playTracks(SONGS, 2)
    const currentId = usePlayer.getState().current?.id
    usePlayer.getState().toggleShuffle()
    usePlayer.getState().toggleShuffle()
    const s = usePlayer.getState()
    expect(s.shuffle).toBe(false)
    expect(s.queue.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(s.current?.id).toBe(currentId)
  })
})

describe('currentPlayMode 派生', () => {
  it('shuffle 优先于 repeat', () => {
    expect(currentPlayMode(true, 'off')).toBe('shuffle')
    expect(currentPlayMode(true, 'one')).toBe('shuffle')
  })

  it('非随机时按 repeat 映射', () => {
    expect(currentPlayMode(false, 'off')).toBe('order')
    expect(currentPlayMode(false, 'all')).toBe('repeat-all')
    expect(currentPlayMode(false, 'one')).toBe('repeat-one')
  })
})

describe('usePlayer.cyclePlayMode（合并播放模式按钮）', () => {
  beforeEach(() => {
    usePlayer.getState().playTracks(SONGS, 2)
  })

  /** 读取当前派生模式。 */
  const mode = () => {
    const s = usePlayer.getState()
    return currentPlayMode(s.shuffle, s.repeat)
  }

  it('从 repeat-all 依次循环 all->one->shuffle->order->all', () => {
    expect(mode()).toBe('repeat-all')
    usePlayer.getState().cyclePlayMode()
    expect(mode()).toBe('repeat-one')
    usePlayer.getState().cyclePlayMode()
    expect(mode()).toBe('shuffle')
    usePlayer.getState().cyclePlayMode()
    expect(mode()).toBe('order')
    usePlayer.getState().cyclePlayMode()
    expect(mode()).toBe('repeat-all')
  })

  it('order/repeat-one 之间切换不改动随机态与队列', () => {
    const before = usePlayer.getState().queue.map((t) => t.id)
    usePlayer.setState({ shuffle: false, repeat: 'off' })
    expect(mode()).toBe('order')
    usePlayer.getState().cyclePlayMode() // -> repeat-all
    const after = usePlayer.getState().queue.map((t) => t.id)
    expect(after).toEqual(before)
    expect(usePlayer.getState().shuffle).toBe(false)
  })

  it('切换到 shuffle 开启随机并保持当前曲目在队首', () => {
    const currentId = usePlayer.getState().current?.id
    usePlayer.setState({ shuffle: false, repeat: 'all' })
    usePlayer.getState().cyclePlayMode() // all -> one
    usePlayer.getState().cyclePlayMode() // one -> shuffle
    const s = usePlayer.getState()
    expect(s.shuffle).toBe(true)
    expect(s.queue[0].id).toBe(currentId)
    expect(s.queue).toHaveLength(5)
  })

  it('从 shuffle 切回 order 恢复原始顺序并保持当前曲目', () => {
    usePlayer.setState({ shuffle: false, repeat: 'all' })
    usePlayer.getState().cyclePlayMode() // -> repeat-one
    usePlayer.getState().cyclePlayMode() // -> shuffle
    const currentId = usePlayer.getState().current?.id
    usePlayer.getState().cyclePlayMode() // shuffle -> order
    const s = usePlayer.getState()
    expect(s.shuffle).toBe(false)
    expect(s.repeat).toBe('off')
    expect(s.queue.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(s.current?.id).toBe(currentId)
  })
})

describe('usePlayer 音量', () => {
  it('setVolume 收敛到 [0,1]', () => {
    usePlayer.getState().setVolume(1.5)
    expect(usePlayer.getState().volume).toBe(1)
    usePlayer.getState().setVolume(-0.5)
    expect(usePlayer.getState().volume).toBe(0)
  })

  it('音量归零时自动静音', () => {
    usePlayer.getState().setVolume(0)
    expect(usePlayer.getState().muted).toBe(true)
  })

  it('toggleMute 切换静音', () => {
    usePlayer.setState({ muted: false })
    usePlayer.getState().toggleMute()
    expect(usePlayer.getState().muted).toBe(true)
    usePlayer.getState().toggleMute()
    expect(usePlayer.getState().muted).toBe(false)
  })
})

describe('usePlayer 队列管理', () => {
  beforeEach(() => {
    usePlayer.getState().playTracks(SONGS, 0)
  })

  it('enqueue 追加到队列尾部且不打断当前播放', () => {
    const before = usePlayer.getState().current?.id
    usePlayer.getState().enqueue([track('6'), track('7')])
    const s = usePlayer.getState()
    expect(s.queue).toHaveLength(7)
    expect(s.current?.id).toBe(before)
  })

  it('enqueue 到空队列时直接播放', () => {
    usePlayer.getState().clearQueue()
    usePlayer.getState().enqueue([track('9')])
    expect(usePlayer.getState().current?.id).toBe('9')
    expect(usePlayer.getState().isPlaying).toBe(true)
  })

  it('removeAt 删除非当前曲目时不影响当前下标', () => {
    usePlayer.setState({ index: 2, current: SONGS[2] })
    usePlayer.getState().removeAt(0)
    const s = usePlayer.getState()
    expect(s.queue).toHaveLength(4)
    expect(s.current?.id).toBe('3')
    expect(s.index).toBe(1)
  })

  it('removeAt 删除当前曲目时顺延到下一首', () => {
    usePlayer.setState({ index: 1, current: SONGS[1] })
    usePlayer.getState().removeAt(1)
    const s = usePlayer.getState()
    expect(s.current?.id).toBe('3')
  })

  it('clearQueue 清空并停止', () => {
    usePlayer.getState().clearQueue()
    const s = usePlayer.getState()
    expect(s.queue).toHaveLength(0)
    expect(s.current).toBeNull()
    expect(s.isPlaying).toBe(false)
    expect(s.index).toBe(-1)
  })

  it('playIndex 跳转到指定曲目', () => {
    usePlayer.getState().playIndex(3)
    expect(usePlayer.getState().current?.id).toBe('4')
    expect(usePlayer.getState().index).toBe(3)
  })

  it('playIndex 越界时忽略', () => {
    usePlayer.setState({ index: 1, current: SONGS[1] })
    usePlayer.getState().playIndex(99)
    expect(usePlayer.getState().index).toBe(1)
  })
})

describe('usePlayer toggle', () => {
  it('无当前曲目时 toggle 从队列头开始播放', () => {
    usePlayer.setState({
      queue: SONGS,
      baseQueue: SONGS,
      current: null,
      index: -1,
      isPlaying: false,
    })
    usePlayer.getState().toggle()
    const s = usePlayer.getState()
    expect(s.current?.id).toBe('1')
    expect(s.isPlaying).toBe(true)
  })

  it('playbackEnded 时 toggle 从第一首重新开始', () => {
    usePlayer.getState().playTracks(SONGS, 4)
    usePlayer.setState({ isPlaying: false, playbackEnded: true })
    usePlayer.getState().toggle()
    const s = usePlayer.getState()
    expect(s.index).toBe(0)
    expect(s.current?.id).toBe('1')
    expect(s.isPlaying).toBe(true)
    expect(s.playbackEnded).toBe(false)
  })

  it('playbackEnded 仅影响顺序播放结束态，手动暂停不受影响', () => {
    usePlayer.getState().playTracks(SONGS, 0)
    usePlayer.getState().toggle() // pause
    expect(usePlayer.getState().isPlaying).toBe(false)
    // 再 toggle 应该恢复播放，而不是跳回第一首
    usePlayer.getState().toggle()
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().index).toBe(0)
  })
})
