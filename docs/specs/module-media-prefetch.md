# Spec — 队列离线预取（前后各 1 首音频 + 歌词）

对应模块：`web/lib/prefetch.ts`、`web/lib/prefetchProtocol.ts`、`web/hooks/usePlaylistPrefetch.ts`、`web/sw.ts`

相关决策：ADR-060（离线保存与预取，修订 ADR-037）、ADR-036（shuffle 排列游走，预取的顺序前提）

## 要构建什么

- 目标：在网络良好且播放侧空闲时，**主动**把队列中相对当前曲**前后各 1 首**下载进「离线保存」并预热歌词，使下一首 / 上一首断网也能播。
- 音频由 Service Worker 自行整段下载写离线保存（页面不接字节）；**不预取封面**（封面交给浏览器 HTTP 缓存，见 ADR-060）；歌词入内存缓存。

## 行为

- 预期行为：
  - `prefetchTargets(queue, index)` 默认半径 `OFFLINE_PREFETCH_RADIUS = 1`，取偏移 `+1,-1`（按队列长度回绕；显式传半径 2 时顺序为 `+1,-1,+2,-2`），按 `keyOf` 去重、剔除当前曲。
  - 门控 `canPrefetch`：`!buffering` 且当前曲 `readyState ≥ 3` 且网络良好（`onLine`、非省流、非 `slow-2g/2g/3g`）。
  - 调度：`current/queue/index/level/buffering/autoPrefetch` 变化 → 重排预取；`autoPrefetch` 关闭时直接 `cancel()`。`settle 2500ms` 防抖（连跳不断重置），发车后经 `requestIdleCallback`（退化 `setTimeout`）**串行**、曲间 `gap 1500ms`。
  - 单首 `prefetchTrack`：音频 `postToServiceWorker({ type:'PREFETCH_AUDIO', … })`、歌词 `prefetchLyric`。**先登记再执行**，幂等。
  - SW 收到 `PREFETCH_AUDIO`：命中缓存或同 key 在途 → no-op；否则整段下载写 IDB；**单飞**（新消息 abort 旧的）。
  - 登录 / 登出清缓存（ADR-034）时同步清空页面去重表。

## 输入 / 输出

- 输入：播放器队列状态（`queue` / `index` / `buffering`）、`audio.readyState`、`navigator.onLine` / `connection`、`settings.level`。
- 输出：离线保存（音频 blob + 元数据 + 来源 `auto`）、歌词内存缓存；均在设置弹窗的「离线保存」里可见 / 可清（自动与显式分开）。

## 约束

- 音频落法为**消息式**：页面不接收字节，SW 自取；复用 `mediaCache` 的 `audioKey` / `pickEvictions` / `saveAudio`（来源标为 `auto`）。
- 预载请求**不带 Range**（SW 仅整文件可缓存）；URL 经 shared `streamUrl` 拼装。
- 预取路径**绝不**弹登录提示（预取的曲目尚未打算播放），403 一律静默跳过。
- 去重键与 SW `audioKey` 同形（含 `level`）；去重表有界（512）。
- 纯函数（`prefetchTargets` / `isNetworkGood` / `canPrefetch` / `prefetchKey`）与协议校验（`parsePrefetchAudio`）不触浏览器 API，可单测。

## 边界条件

- 队列过短：`len 1→0，2→1，3→2，4→3，5→4`（回绕去重）。
- 队列内重复曲目：按 `keyOf` 去重。
- `index` 越界 / `-1`：目标为空 → `cancel()`。
- `repeat='one'`：不影响预取目标（仍取 ±1，用户仍可能手动切歌）。
- shuffle：只读 `queue`（已重排的排列），**绝不用 `baseQueue`**。
- 浏览器不支持 `connection` / `requestIdleCallback`：分别「视为良好」、退化 `setTimeout`。
- SW 未 controller（首载）：音频预取静默缺席，歌词仍预。
- VIP / 版权（后端 403）/ 非整段音频：静默丢弃响应体、不缓存、不通知登录。

## 验收标准

- [x] `prefetchTargets`：默认 ±1、显式半径 2 的顺序、回绕、短队列去重、重复曲目、越界 —— `test/lib/prefetch.test.ts`。
- [x] `isNetworkGood` / `canPrefetch`：离线、省流、各 `effectiveType`、未知类型、缓冲、`readyState` —— 同上。
- [x] 去重表按 `level` 区分、上限淘汰、`clearPrefetchRegistry` —— 同上。
- [x] `prefetchTrack`：发消息 + 歌词、**不预取封面**、幂等、换档重发 —— 同上。
- [x] `createPrefetchScheduler`：静置防抖、串行、`gate` 中途失效、重排取消、`cancel`、默认 `idle` 退化 —— 同上。
- [x] `parsePrefetchAudio` / `prefetchAudioMessage`：合法、档位归一、非法输入 —— `test/lib/prefetchProtocol.test.ts`。
- [x] `clearAllAppCaches` 清空预载去重表 —— `test/lib/clearCaches.test.ts`。
- [x] `pnpm typecheck` 与 `pnpm test` 零错误 / 全绿。

## 完成定义

- 如何判定已完成：单元测试覆盖各纯函数分支与调度器行为且全绿；手动在 DevTools 观察空转数秒后 IDB `pterosaur.mediaMeta` 出现 ±1 曲目条目，断网后「下一首」可直接播放。
