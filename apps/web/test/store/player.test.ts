import { describe, it, expect, beforeEach } from 'vitest'
import {
  advanceOnEnd,
  shuffledIndexes,
  currentPlayMode,
  audioSrc,
  playerCommands,
} from '../../src/store/player.js'
import { usePlayerQueue } from '../../src/store/playerQueue.js'
import { usePlaybackSession } from '../../src/store/playbackSession.js'
import { usePlayerUi } from '../../src/store/playerUi.js'
import { audioEl } from '../../src/hooks/audioElement.js'
import type { Track } from '@pterosaur/shared/types'

/** 构造测试用曲目。 */
function track(id: string, title = `曲目${id}`): Track {
  return {
    source: 'netease',
    id,
    title,
    artist: '艺术家',
    album: '专辑',
    cover: '',
    duration: 100,
    fee: 'free',
  }
}

const SONGS = [track('1'), track('2'), track('3'), track('4'), track('5')]

/** 每个测试前重置 store 到初始态。 */
beforeEach(() => {
  usePlayerQueue.setState({
    queue: [],
    index: -1,
    baseQueue: [],
    volume: 0.8,
    muted: false,
    repeat: 'all',
    shuffle: false,
  })
  usePlaybackSession.setState({
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    playError: null,
    playErrorNeedLogin: false,
    buffering: false,
  })
  usePlayerUi.setState({
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
    usePlaybackSession.getState().setPlayError('该曲目暂不可播放', true)
    expect(usePlaybackSession.getState().playError).toBe('该曲目暂不可播放')
    expect(usePlaybackSession.getState().playErrorNeedLogin).toBe(true)

    // 网络类错误：不需要登录入口
    usePlaybackSession.getState().setPlayError('网络不稳定', false)
    expect(usePlaybackSession.getState().playError).toBe('网络不稳定')
    expect(usePlaybackSession.getState().playErrorNeedLogin).toBe(false)
  })

  it('setPlayError(null) 清除错误并复位登录标志', () => {
    usePlaybackSession.getState().setPlayError('该曲目暂不可播放', true)
    usePlaybackSession.getState().setPlayError(null)
    expect(usePlaybackSession.getState().playError).toBeNull()
    expect(usePlaybackSession.getState().playErrorNeedLogin).toBe(false)
  })

  it('setBuffering 切换缓冲态', () => {
    expect(usePlaybackSession.getState().buffering).toBe(false)
    usePlaybackSession.getState().setBuffering(true)
    expect(usePlaybackSession.getState().buffering).toBe(true)
    usePlaybackSession.getState().setBuffering(false)
    expect(usePlaybackSession.getState().buffering).toBe(false)
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

describe('player.playTracks', () => {
  it('以指定曲目为队列并从 startIndex 播放', () => {
    playerCommands.playTracks(SONGS, 2)

    expect(usePlayerQueue.getState().queue).toHaveLength(5)
    expect(usePlayerQueue.getState().index).toBe(2)
    expect(usePlaybackSession.getState().current?.id).toBe('3')
    expect(usePlaybackSession.getState().isPlaying).toBe(true)
    expect(usePlaybackSession.getState().position).toBe(0)
  })

  it('startIndex 越界时收敛到合法范围', () => {
    playerCommands.playTracks(SONGS, 99)
    expect(usePlayerQueue.getState().index).toBe(4)
    playerCommands.playTracks(SONGS, -5)
    expect(usePlayerQueue.getState().index).toBe(0)
  })

  it('空数组不改变状态', () => {
    playerCommands.playTracks([])
    expect(usePlaybackSession.getState().current).toBeNull()
  })

  it('baseQueue 保存原始顺序', () => {
    playerCommands.playTracks(SONGS, 0)
    expect(usePlayerQueue.getState().baseQueue.map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
  })
})

describe('player.next / prev', () => {
  beforeEach(() => {
    playerCommands.playTracks(SONGS, 0)
  })

  it('next 前进到下一首', () => {
    playerCommands.next()
    expect(usePlaybackSession.getState().current?.id).toBe('2')
    expect(usePlayerQueue.getState().index).toBe(1)
  })

  it('repeat=all 时末尾 next 回到 0', () => {
    usePlaybackSession.setState({ current: SONGS[4] })
    usePlayerQueue.setState({ index: 4 })
    playerCommands.next()
    expect(usePlayerQueue.getState().index).toBe(0)
  })

  it('repeat=off 时末尾 next 停止并标记已结束', () => {
    usePlaybackSession.setState({ current: SONGS[4] })
    usePlayerQueue.setState({ index: 4, repeat: 'off' })
    playerCommands.next()

    expect(usePlayerQueue.getState().index).toBe(4)
    expect(usePlaybackSession.getState().isPlaying).toBe(false)
    expect(usePlaybackSession.getState().position).toBe(0)
    expect(usePlaybackSession.getState().playbackEnded).toBe(true)
  })

  it('prev 回到上一首', () => {
    usePlaybackSession.setState({ current: SONGS[2], position: 0 })
    usePlayerQueue.setState({ index: 2 })
    playerCommands.prev()
    expect(usePlayerQueue.getState().index).toBe(1)
  })

  it('position>3 时 prev 仅回到开头', () => {
    usePlaybackSession.setState({ current: SONGS[2], position: 30 })
    usePlayerQueue.setState({ index: 2 })
    playerCommands.prev()
    expect(usePlayerQueue.getState().index).toBe(2)
    expect(usePlaybackSession.getState().position).toBe(0)
  })

  it('position>3 时 prev 命令式回开头（驱动 audio.currentTime，防单向回写覆盖回归）', () => {
    // 回归背景：曾用 set({position:0}) 实现，但引擎每帧以 audio.currentTime
    // 回写 store.position，store 侧置 0 会被覆盖——点击表现为毫无反应。
    // prev 必须经 seekTo 真正拨动 audio.currentTime。
    const fake = { currentTime: 30, duration: 100 }
    audioEl.current = fake as unknown as HTMLAudioElement
    try {
      usePlaybackSession.setState({ current: SONGS[2], position: 30 })
      usePlayerQueue.setState({ index: 2 })
      playerCommands.prev()
      expect(fake.currentTime).toBe(0)
      expect(usePlaybackSession.getState().position).toBe(0)
      expect(usePlayerQueue.getState().index).toBe(2)
    } finally {
      audioEl.current = null
    }
  })

  it('开头 prev 回到末尾（repeat=all 语境）', () => {
    usePlaybackSession.setState({ current: SONGS[0], position: 0 })
    usePlayerQueue.setState({ index: 0 })
    playerCommands.prev()
    expect(usePlayerQueue.getState().index).toBe(4)
  })
})

describe('player shuffle 顺序游走（无随机）', () => {
  // shuffle 只是把队列一次性重排；next/prev 应顺序游走（不再 Math.random），
  // 故这里全部读取 store 里的实际排列来断言，不依赖随机结果。
  beforeEach(() => {
    usePlayerQueue.setState({ shuffle: true, repeat: 'all' })
    playerCommands.playTracks(SONGS, 0)
  })

  it('next 走 index+1（按队列顺序，而非随机跳转）', () => {
    const q = usePlayerQueue.getState().queue
    expect(q).toHaveLength(5)
    playerCommands.next()
    expect(usePlayerQueue.getState().index).toBe(1)
    expect(usePlaybackSession.getState().current?.id).toBe(q[1].id)
  })

  it('连按 next 遍历整个排列且不重复，末尾回绕到 0', () => {
    const q = usePlayerQueue.getState().queue
    const seen = [q[0].id]
    for (let i = 0; i < q.length - 1; i++) {
      playerCommands.next()
      seen.push(usePlaybackSession.getState().current?.id ?? '')
    }
    expect(seen).toEqual(q.map((t) => t.id))
    expect(new Set(seen).size).toBe(q.length)
    // 再按一次 → 回绕到队首
    playerCommands.next()
    expect(usePlayerQueue.getState().index).toBe(0)
  })

  it('prev 走 index-1，开头回绕到末尾', () => {
    const q = usePlayerQueue.getState().queue
    usePlaybackSession.setState({ current: q[3], position: 0 })
    usePlayerQueue.setState({ index: 3 })
    playerCommands.prev()
    expect(usePlayerQueue.getState().index).toBe(2)
    expect(usePlaybackSession.getState().current?.id).toBe(q[2].id)

    usePlaybackSession.setState({ current: q[0], position: 0 })
    usePlayerQueue.setState({ index: 0 })
    playerCommands.prev()
    expect(usePlayerQueue.getState().index).toBe(4)
  })

  it('末尾 next + repeat=off → 停止并标记已结束', () => {
    usePlayerQueue.setState({ repeat: 'off' })
    usePlaybackSession.setState({ current: usePlayerQueue.getState().queue[4] })
    usePlayerQueue.setState({ index: 4 })
    playerCommands.next()

    expect(usePlayerQueue.getState().index).toBe(4)
    expect(usePlaybackSession.getState().isPlaying).toBe(false)
    expect(usePlaybackSession.getState().playbackEnded).toBe(true)
  })

  it('末尾 next + repeat=one → 与 off 一致地停止（固化既有语义）', () => {
    usePlayerQueue.setState({ repeat: 'one' })
    usePlaybackSession.setState({ current: usePlayerQueue.getState().queue[4] })
    usePlayerQueue.setState({ index: 4 })
    playerCommands.next()

    expect(usePlayerQueue.getState().index).toBe(4)
    expect(usePlaybackSession.getState().isPlaying).toBe(false)
    expect(usePlaybackSession.getState().playbackEnded).toBe(true)
  })

  it('手动 next 与自然结束推进 advanceOnEnd 一致', () => {
    const len = usePlayerQueue.getState().queue.length
    for (let i = 0; i < len; i++) {
      usePlayerQueue.setState({
        index: i,
      })
      usePlaybackSession.setState({
        current: usePlayerQueue.getState().queue[i],
        position: 0,
      })
      playerCommands.next()
      expect(usePlayerQueue.getState().index).toBe(advanceOnEnd(i, len, 'all'))
    }
  })
})

describe('player 播放模式', () => {
  it('cycleRepeat 循环切换 off->all->one->off', () => {
    usePlayerQueue.setState({ repeat: 'off' })
    usePlayerQueue.getState().cycleRepeat()
    expect(usePlayerQueue.getState().repeat).toBe('all')
    usePlayerQueue.getState().cycleRepeat()
    expect(usePlayerQueue.getState().repeat).toBe('one')
    usePlayerQueue.getState().cycleRepeat()
    expect(usePlayerQueue.getState().repeat).toBe('off')
  })

  it('toggleShuffle 开启后保持当前曲目并重排', () => {
    playerCommands.playTracks(SONGS, 2)
    const currentId = usePlaybackSession.getState().current?.id
    playerCommands.toggleShuffle()

    expect(usePlayerQueue.getState().shuffle).toBe(true)
    // 当前曲目应排在打乱队列首位
    expect(usePlayerQueue.getState().queue[0].id).toBe(currentId)
    expect(usePlayerQueue.getState().queue).toHaveLength(5)
  })

  it('toggleShuffle 关闭后恢复原始顺序并保持当前曲目', () => {
    playerCommands.playTracks(SONGS, 2)
    const currentId = usePlaybackSession.getState().current?.id
    playerCommands.toggleShuffle()
    playerCommands.toggleShuffle()

    expect(usePlayerQueue.getState().shuffle).toBe(false)
    expect(usePlayerQueue.getState().queue.map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    expect(usePlaybackSession.getState().current?.id).toBe(currentId)
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

describe('player.cyclePlayMode（合并播放模式按钮）', () => {
  beforeEach(() => {
    playerCommands.playTracks(SONGS, 2)
  })

  /** 读取当前派生模式。 */
  const mode = () => {
    return currentPlayMode(
      usePlayerQueue.getState().shuffle,
      usePlayerQueue.getState().repeat,
    )
  }

  it('从 repeat-all 依次循环 all->one->shuffle->order->all', () => {
    expect(mode()).toBe('repeat-all')
    playerCommands.cyclePlayMode()
    expect(mode()).toBe('repeat-one')
    playerCommands.cyclePlayMode()
    expect(mode()).toBe('shuffle')
    playerCommands.cyclePlayMode()
    expect(mode()).toBe('order')
    playerCommands.cyclePlayMode()
    expect(mode()).toBe('repeat-all')
  })

  it('order/repeat-one 之间切换不改动随机态与队列', () => {
    const before = usePlayerQueue.getState().queue.map((t) => t.id)
    usePlayerQueue.setState({ shuffle: false, repeat: 'off' })
    expect(mode()).toBe('order')
    playerCommands.cyclePlayMode() // -> repeat-all
    const after = usePlayerQueue.getState().queue.map((t) => t.id)
    expect(after).toEqual(before)
    expect(usePlayerQueue.getState().shuffle).toBe(false)
  })

  it('切换到 shuffle 开启随机并保持当前曲目在队首', () => {
    const currentId = usePlaybackSession.getState().current?.id
    usePlayerQueue.setState({ shuffle: false, repeat: 'all' })
    playerCommands.cyclePlayMode() // all -> one
    playerCommands.cyclePlayMode() // one -> shuffle

    expect(usePlayerQueue.getState().shuffle).toBe(true)
    expect(usePlayerQueue.getState().queue[0].id).toBe(currentId)
    expect(usePlayerQueue.getState().queue).toHaveLength(5)
  })

  it('从 shuffle 切回 order 恢复原始顺序并保持当前曲目', () => {
    usePlayerQueue.setState({ shuffle: false, repeat: 'all' })
    playerCommands.cyclePlayMode() // -> repeat-one
    playerCommands.cyclePlayMode() // -> shuffle
    const currentId = usePlaybackSession.getState().current?.id
    playerCommands.cyclePlayMode() // shuffle -> order

    expect(usePlayerQueue.getState().shuffle).toBe(false)
    expect(usePlayerQueue.getState().repeat).toBe('off')
    expect(usePlayerQueue.getState().queue.map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    expect(usePlaybackSession.getState().current?.id).toBe(currentId)
  })
})

describe('player 音量', () => {
  it('setVolume 收敛到 [0,1]', () => {
    usePlayerQueue.getState().setVolume(1.5)
    expect(usePlayerQueue.getState().volume).toBe(1)
    usePlayerQueue.getState().setVolume(-0.5)
    expect(usePlayerQueue.getState().volume).toBe(0)
  })

  it('音量归零时自动静音', () => {
    usePlayerQueue.getState().setVolume(0)
    expect(usePlayerQueue.getState().muted).toBe(true)
  })

  it('toggleMute 切换静音', () => {
    usePlayerQueue.setState({ muted: false })
    usePlayerQueue.getState().toggleMute()
    expect(usePlayerQueue.getState().muted).toBe(true)
    usePlayerQueue.getState().toggleMute()
    expect(usePlayerQueue.getState().muted).toBe(false)
  })
})

describe('player 队列管理', () => {
  beforeEach(() => {
    playerCommands.playTracks(SONGS, 0)
  })

  it('enqueue 追加到队列尾部且不打断当前播放', () => {
    const before = usePlaybackSession.getState().current?.id
    playerCommands.enqueue([track('6'), track('7')])

    expect(usePlayerQueue.getState().queue).toHaveLength(7)
    expect(usePlaybackSession.getState().current?.id).toBe(before)
  })

  it('enqueue 到空队列时直接播放', () => {
    playerCommands.clearQueue()
    playerCommands.enqueue([track('9')])
    expect(usePlaybackSession.getState().current?.id).toBe('9')
    expect(usePlaybackSession.getState().isPlaying).toBe(true)
  })

  it('removeAt 删除非当前曲目时不影响当前下标', () => {
    usePlaybackSession.setState({ current: SONGS[2] })
    usePlayerQueue.setState({ index: 2 })
    playerCommands.removeAt(0)

    expect(usePlayerQueue.getState().queue).toHaveLength(4)
    expect(usePlaybackSession.getState().current?.id).toBe('3')
    expect(usePlayerQueue.getState().index).toBe(1)
  })

  it('removeAt 删除当前曲目时顺延到下一首', () => {
    usePlaybackSession.setState({ current: SONGS[1] })
    usePlayerQueue.setState({ index: 1 })
    playerCommands.removeAt(1)

    expect(usePlaybackSession.getState().current?.id).toBe('3')
  })

  it('clearQueue 清空并停止', () => {
    playerCommands.clearQueue()

    expect(usePlayerQueue.getState().queue).toHaveLength(0)
    expect(usePlaybackSession.getState().current).toBeNull()
    expect(usePlaybackSession.getState().isPlaying).toBe(false)
    expect(usePlayerQueue.getState().index).toBe(-1)
  })

  it('playIndex 跳转到指定曲目', () => {
    playerCommands.playIndex(3)
    expect(usePlaybackSession.getState().current?.id).toBe('4')
    expect(usePlayerQueue.getState().index).toBe(3)
  })

  it('playIndex 越界时忽略', () => {
    usePlaybackSession.setState({ current: SONGS[1] })
    usePlayerQueue.setState({ index: 1 })
    playerCommands.playIndex(99)
    expect(usePlayerQueue.getState().index).toBe(1)
  })
})

describe('player toggle', () => {
  it('无当前曲目时 toggle 从队列头开始播放', () => {
    usePlayerQueue.setState({
      queue: SONGS,
      baseQueue: SONGS,
      index: -1,
    })
    usePlaybackSession.setState({
      current: null,
      isPlaying: false,
    })
    playerCommands.toggle()

    expect(usePlaybackSession.getState().current?.id).toBe('1')
    expect(usePlaybackSession.getState().isPlaying).toBe(true)
  })

  it('playbackEnded 时 toggle 从第一首重新开始', () => {
    playerCommands.playTracks(SONGS, 4)
    usePlaybackSession.setState({ isPlaying: false, playbackEnded: true })
    playerCommands.toggle()

    expect(usePlayerQueue.getState().index).toBe(0)
    expect(usePlaybackSession.getState().current?.id).toBe('1')
    expect(usePlaybackSession.getState().isPlaying).toBe(true)
    expect(usePlaybackSession.getState().playbackEnded).toBe(false)
  })

  it('playbackEnded 仅影响顺序播放结束态，手动暂停不受影响', () => {
    playerCommands.playTracks(SONGS, 0)
    playerCommands.toggle() // pause
    expect(usePlaybackSession.getState().isPlaying).toBe(false)
    // 再 toggle 应该恢复播放，而不是跳回第一首
    playerCommands.toggle()
    expect(usePlaybackSession.getState().isPlaying).toBe(true)
    expect(usePlayerQueue.getState().index).toBe(0)
  })
})

describe('playerQueue 持久化载荷', () => {
  it('partialize 只含数据字段（IDB structured clone 不能克隆函数）', () => {
    playerCommands.playTracks(SONGS, 0)
    const options = usePlayerQueue.persist.getOptions()
    const persisted = options.partialize!(usePlayerQueue.getState())
    expect(() => structuredClone(persisted)).not.toThrow()
    for (const value of Object.values(persisted)) {
      expect(typeof value).not.toBe('function')
    }
    expect(persisted.queue).toHaveLength(5)
    // 瞬态字段不得进入持久化载荷
    expect(persisted).not.toHaveProperty('position')
    expect(persisted).not.toHaveProperty('isPlaying')
    expect(persisted).not.toHaveProperty('expanded')
  })
})
