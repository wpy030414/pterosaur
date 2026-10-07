# Spec — 播放器状态机（队列 / 循环 / 随机 / 进度）

对应模块：`src/store/player.ts`、`src/hooks/useAudioEngine.ts`、`src/hooks/audioElement.ts`

## 要构建什么

- 目标：以单一状态机管理「播放什么、播到哪、以什么顺序续播」，并把意图可靠地翻译成真实 `<audio>` 行为；支持列表循环/单曲循环/不循环、随机播放、进度 seek、音量与持久化。

## 行为

- 预期行为：
  - `playTracks(tracks, startIndex)`：以传入列表为新队列并从指定曲目播放，重置进度并进入播放态；`baseQueue` 保存未打乱的原始顺序。
  - `next()/prev()`：**顺序游走**（`next = index+1`、`prev = index−1`，越界按 `repeat` 回绕/停止）；`shuffle` 只决定队列是否被一次性重排，不改变游走方式；`prev` 在已播放 >3s 时先回到本曲开头。
  - 自然结束（audio `ended`）：`repeat=one` 重播本曲；否则调 `next()`（`off` 且为末曲时停止）。
  - `cycleRepeat()`：`off → all → one → off`。
  - `toggleShuffle()`：开启时以当前曲目为种子 Fisher–Yates 重排并置其为首；关闭时恢复 `baseQueue` 原序并保持当前曲目。
  - `enqueue()`：追加到队尾且不打断当前播放；队列空时等价于 `playTracks`。
  - `removeAt(i)`：删除任意位置并正确修正当前下标与 `current`；删空则停止。
  - 进度：播放中由 rAF 单向把 `audio.currentTime` 回写 `position`；用户跳转一律走 `seekTo()`（同写 audio 与 store）。
  - 音量：`setVolume` 收敛到 [0,1]，归零即静音；`toggleMute` 独立切换。
  - 持久化：`partialize` 仅存队列/偏好/当前曲目，冷启动 `isPlaying=false, position=0`。

## 输入 / 输出

- 输入：曲目列表、下标、用户操作（播放/暂停/切歌/拖拽/音量/模式切换）、audio 事件（timeupdate/loadedmetadata/ended/error/play/pause）。
- 输出：store 状态（供 UI 订阅渲染）与对 `<audio>` 的命令（src/play/pause/currentTime/volume/muted）。

## 约束

- 全局仅一个 `<audio>` 实例，由 `useAudioEngine` 独占驱动；组件不得直接操作它（seek 除外，且必须经 `seekTo()`）。
- 任何组件不得直接写 `store.position`；进度真相源在播放时是 audio、在拖拽时是用户意图。
- 浏览器自动播放策略：`play()` 被拒（NotAllowedError）时静默转暂停，不弹错误。
- 换源只在 `current` 变化时进行，且 src 未变则不重复 `load()`。

## 边界条件

- 空队列：`playTracks([])` 不改状态；`next/prev` 直接返回。
- 单曲队列：`next`/`prev` 指向自身；`repeat=one` 持续重播。
- `startIndex` 越界：收敛到 [0, len-1]。
- 删除当前曲：顺延到相邻曲；删除后队列为空则停止并清零进度。
- shuffle 下 `next`/`prev`：与顺序模式同样顺序游走（队列已在开启 shuffle 时一次性重排，**不重复**），末尾按 `repeat` 回绕或停止；与自然结束的 `advanceOnEnd` 一致（见 ADR-036）。
- VIP/版权受限：audio `error`（code 2）→ 暂停并置 `playError`，由 Toast 提示登录。

## 验收标准

- [x] `advanceOnEnd` 六种组合（one/all/off × 中间/末尾）与空队列返回值正确。
- [x] `shuffledIndexes` 不重不漏且种子曲目居首。
- [x] `playTracks` 队列/下标/当前曲/播放态/越界收敛/空数组行为正确。
- [x] `next/prev` 在 all/off、开头/末尾、position>3 各分支正确。
- [x] shuffle 下 `next/prev` **顺序游走**：不重复、与 `advanceOnEnd` 一致、末尾按 `repeat` 回绕/停止（`test/store/player.test.ts`）。
- [x] `cycleRepeat`、`toggleShuffle`（开/关且保持当前曲）正确。
- [x] `setVolume` 收敛与归零静音、`toggleMute` 正确。
- [x] `enqueue`（追加/空队列）、`removeAt`（删非当前/删当前/删空）、`playIndex`（跳转/越界）、`clearQueue`、`toggle`（无当前曲/有当前曲）正确。
- [x] 以上由 `test/store/player.test.ts` 覆盖并通过；真实播放由 E2E「点击结果行开始真实播放」验证（audio 未暂停且 currentTime 前进）。

## 完成定义

- 如何判定已完成：`pnpm test` 中 player store 用例全绿；E2E 播放/暂停/切歌用例通过；`tsc -p tsconfig.app.json` 零错误。
