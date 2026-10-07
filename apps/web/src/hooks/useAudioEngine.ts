import { useEffect, useRef } from 'react'
import { keyOf } from '@pterosaur/shared/types'
import { COVER_LARGE } from '@pterosaur/shared/image'
import { usePlayer, audioSrc, advanceOnEnd } from '../store/player.js'
import { useLibrary } from '../store/library.js'
import { useSettings } from '../store/settings.js'
import { audioEl } from './audioElement.js'
import {
  createWatchdog,
  isPlaybackHealthy,
  isPrematureEnd,
  type Watchdog,
} from '../lib/playbackWatchdog.js'

/** 起播超时（毫秒）：弱网下 play() 长期既不 resolve 也不 reject 时的兜底。 */
const PLAY_START_TIMEOUT_MS = 12_000

/**
 * 全局唯一的 `<audio>` 引擎。
 *
 * 只挂载一次（在 App 顶层），负责：
 * - 把 store 中的 current/isPlaying/volume 同步到真实 audio 元素；
 * - 把 audio 的时间/结束/错误事件回写到 store；
 * - 处理「曲目自然结束」后的循环/随机推进；
 * - 处理 VIP/版权导致的播放失败。
 *
 * 进度 seek 由 {@link seekTo} 命令式处理，本引擎只单向回写播放位置。
 */
export function useAudioEngine(): void {
  const getState = () => usePlayer.getState()
  // 弱网停滞看门狗：事件 effect 创建，换曲 effect 复位（经 ref 互通）
  const watchdogRef = useRef<Watchdog | null>(null)
  // 重载豁免位：load()（弱网恢复 / 换档）会派发一次 pause，需豁免其回写；跨 effect 经 ref 互通
  const recoveringRef = useRef(false)
  // 已加载曲目的 `source:id`，用于区分「换曲」（重置进度）与「同曲换档」（保留进度）
  const loadedKeyRef = useRef('')

  // current / level 变化 -> 换源（同曲换档时保留播放位置）
  const current = usePlayer((s) => s.current)
  const level = useSettings((s) => s.level)
  useEffect(() => {
    const audio = audioEl.current
    if (!audio) return
    const src = audioSrc(current, level)
    const key = current ? keyOf(current) : ''
    const sameTrack = !!key && key === loadedKeyRef.current
    const resumeAt = sameTrack ? audio.currentTime : 0
    loadedKeyRef.current = key
    // 换源即进入缓冲态（待 canplay/playing 后解除），并复位停滞看门狗
    getState().setBuffering(Boolean(src))
    watchdogRef.current?.reset()
    if (!src) {
      audio.removeAttribute('src')
      audio.load()
      return
    }
    const abs = new URL(src, window.location.origin).href
    if (audio.src === abs) return
    audio.src = abs
    if (sameTrack) {
      // 同曲换档：重载并保留位置（与弱网恢复同一手法），并豁免 load 触发的 pause
      recoveringRef.current = true
      audio.load()
      const seekBack = () => {
        try {
          audio.currentTime = resumeAt
        } catch {
          /* 元数据未就绪时忽略，随后由 loadedmetadata 补做 */
        }
      }
      seekBack()
      audio.addEventListener('loadedmetadata', seekBack, { once: true })
      if (getState().isPlaying) {
        void audio.play().catch(() => {
          /* 起播失败交由 error / 看门狗兜底 */
        })
      }
    } else {
      audio.load()
    }
  }, [current, level])

  // isPlaying -> play/pause
  const isPlaying = usePlayer((s) => s.isPlaying)
  useEffect(() => {
    const audio = audioEl.current
    if (!audio || !current) return
    if (!isPlaying) {
      audio.pause()
      return
    }
    // 元素处于错误态（如上次请求失败）时直接 play() 不会重新拉流，先 reset 再播
    if (
      audio.error ||
      audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE
    ) {
      audio.load()
    }
    // 起播超时兜底：弱网下 play() 可能长时间不 settle，超时后回到暂停态并提示，
    // 避免 UI 停在「播放中」而实际无声（迟到的 resolve 会因 isPlaying 已为 false 被暂停）
    let timer = 0
    const started = audio.play()
    timer = window.setTimeout(() => {
      getState().setPlaying(false)
      getState().setPlayError('网络不稳定，请稍后再试')
    }, PLAY_START_TIMEOUT_MS)
    started
      .then(() => window.clearTimeout(timer))
      .catch((e: unknown) => {
        window.clearTimeout(timer)
        // 恢复重载（load）或暂停会打断未 settle 的 play()，属预期内，静默忽略
        if (e instanceof DOMException && e.name === 'AbortError') return
        const msg = e instanceof Error ? e.message : String(e)
        getState().setPlaying(false)
        // 浏览器自动播放策略：静默暂停，等待用户手势，不报错
        if (
          !/NotAllowedError|user didn't interact|play\(\) failed/i.test(msg)
        ) {
          getState().setPlayError('播放出错，请检查网络后重试')
        }
      })
    return () => window.clearTimeout(timer)
  }, [isPlaying, current])

  // volume / muted
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  useEffect(() => {
    const audio = audioEl.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted])

  // 事件绑定 + 进度回写（rAF 平滑）
  useEffect(() => {
    const audio = audioEl.current
    if (!audio) return

    let rafId = 0
    let disposed = false
    // 重载（load：弱网恢复 / 换档）会派发一次 pause，需豁免其回写
    recoveringRef.current = false
    const watchdog = createWatchdog()
    watchdogRef.current = watchdog

    const onDuration = () => {
      if (disposed) return
      const d = audio.duration
      if (Number.isFinite(d)) getState().setDuration(d)
    }

    const onPlay = () => {
      if (!disposed) getState().setPlaying(true)
    }
    const onPause = () => {
      if (disposed) return
      if (recoveringRef.current) {
        // 重载引发的暂停：不覆盖播放态，仅复位豁免
        recoveringRef.current = false
        return
      }
      // ended 触发的 pause 不应覆盖播放态，交由 ended 处理
      if (!audio.ended) getState().setPlaying(false)
      getState().setBuffering(false)
    }

    // 缓冲耗尽（waiting / stalled）：数据未就绪，进入缓冲态。
    // 防御事件误报：Chromium 在 seek 目标已缓冲时会**迟发** waiting（晚于 playing，
    // 且此后不再有 canplay/playing 来解除）；stalled 也仅表示网络取数暂无进展。
    // 播放实际健康（未暂停、非 seek 中、有未来数据）时均为误报，直接忽略。
    const onWaiting = () => {
      if (disposed) return
      if (isPlaybackHealthy(audio.paused, audio.seeking, audio.readyState))
        return
      getState().setBuffering(true)
    }
    // 数据就绪（playing / canplay）：退出缓冲态
    const onPlaybackReady = () => {
      if (!disposed) getState().setBuffering(false)
    }

    const onEnded = () => {
      if (disposed) return
      const s = getState()
      s.setBuffering(false)
      // 提前结束：上游流被截断（audio 时长被钳短）。尝试原地续播而非当作自然结束，
      // 避免弱网下逐首级联切歌；恢复预算耗尽则暂停并提示（不自动跳歌）。
      if (isPrematureEnd(audio.duration, s.current?.duration)) {
        if (watchdog.noteInterrupt(performance.now())) {
          recoverPlayback()
        } else {
          s.setPlaying(false)
          s.setPlayError('网络不稳定，播放已暂停')
        }
        return
      }
      const { index, queue, repeat } = s
      const nextIndex = advanceOnEnd(index, queue.length, repeat)
      if (nextIndex === null) {
        // 顺序播放到尾 → 停止并标记结束
        audio.currentTime = 0
        s.setPosition(0)
        s.setPlaying(false)
        s.setPlaybackEnded(true)
      } else if (nextIndex === index) {
        // repeat='one'：循环当前曲目（起播失败不静默，回退暂停态并提示）
        audio.currentTime = 0
        void audio.play().catch(() => {
          s.setPlaying(false)
          s.setPlayError('播放中断')
        })
      } else {
        s.playIndex(nextIndex)
      }
    }

    const onError = () => {
      if (disposed) return
      const s = getState()
      s.setPlaying(false)
      s.setBuffering(false)
      // 已由 SW 标记为「需登录」（后端 403）：保留该提示，勿被中性文案覆盖
      if (s.playError && s.playErrorNeedLogin) return
      const err = audio.error
      // 元素的 error 无法区分网络失败 / 源不可用 / VIP 受限，一律给中性提示；
      // VIP 的「登录解锁」引导由 SW 针对后端 403 的通知单独驱动。
      s.setPlayError(err ? '播放出错，请检查网络后重试' : '播放中断')
    }

    /**
     * 弱网恢复：重新加载媒体管线并按原位置续播。
     * `load()` 重置元素并重新发起点播请求（SW 命中缓存则秒回）；
     * 随后把 currentTime 拨回断点，赋值被忽略时待 loadedmetadata 补一次。
     */
    const recoverPlayback = () => {
      const t = audio.currentTime
      const seekBack = () => {
        try {
          audio.currentTime = t
        } catch {
          /* 元数据未就绪时忽略，随后由 loadedmetadata 补做 */
        }
      }
      recoveringRef.current = true
      audio.load()
      seekBack()
      audio.addEventListener('loadedmetadata', seekBack, { once: true })
      void audio.play().catch(() => {
        /* 起播失败交由 error / 看门狗兜底 */
      })
    }

    const tick = () => {
      if (disposed) return
      const s = getState()
      if (!audio.paused && Math.abs(audio.currentTime - s.position) > 0.05) {
        s.setPosition(audio.currentTime)
      }
      // 缓冲态仲裁：事件侧防御（onWaiting）可能漏网（如迟发 waiting 到达时数据
      // 尚未就绪、随后就绪但不再有任何解除事件），故每帧以真实播放状态为最终
      // 事实——正在出声且数据就绪时，卡死的缓冲态立即纠正为 false。
      if (
        s.buffering &&
        isPlaybackHealthy(audio.paused, audio.seeking, audio.readyState)
      ) {
        s.setBuffering(false)
      }
      // 弱网停滞看门狗：静默过久则尝试恢复，预算耗尽则暂停并提示
      const action = watchdog.tick(performance.now(), {
        paused: audio.paused,
        currentTime: audio.currentTime,
        readyState: audio.readyState,
      })
      if (action === 'recover') {
        recoverPlayback()
      } else if (action === 'giveUp') {
        s.setPlaying(false)
        s.setPlayError('网络不稳定，播放已暂停')
      }
      rafId = requestAnimationFrame(tick)
    }

    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('loadedmetadata', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onWaiting)
    audio.addEventListener('playing', onPlaybackReady)
    audio.addEventListener('canplay', onPlaybackReady)
    rafId = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      watchdogRef.current = null
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('loadedmetadata', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onWaiting)
      audio.removeEventListener('playing', onPlaybackReady)
      audio.removeEventListener('canplay', onPlaybackReady)
    }
  }, [])

  // 切歌即记录到「最近播放」
  useEffect(() => {
    if (current) useLibrary.getState().addRecent(current)
  }, [current])

  // 文档标题
  useEffect(() => {
    document.title = current
      ? `${current.title} - ${current.artist} · Pterosaur`
      : 'Pterosaur · 音乐'
  }, [current])

  // 媒体会话（系统级控制 / 锁屏信息）
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator))
      return
    if (!current) {
      navigator.mediaSession.metadata = null
      return
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork: current.cover
        ? [
            {
              src: current.cover,
              sizes: `${COVER_LARGE}x${COVER_LARGE}`,
              type: 'image/jpeg',
            },
          ]
        : [],
    })
    const s = getState()
    navigator.mediaSession.setActionHandler('play', () => s.setPlaying(true))
    navigator.mediaSession.setActionHandler('pause', () => s.setPlaying(false))
    navigator.mediaSession.setActionHandler('previoustrack', () => s.prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => s.next())
  }, [current])
}
