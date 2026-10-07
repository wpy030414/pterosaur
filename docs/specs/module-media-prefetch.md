# Spec — 队列预载（前后各 2 首音频 / 封面 / 歌词）

对应模块：`web/lib/prefetch.ts`、`web/lib/prefetchProtocol.ts`、`web/hooks/usePlaylistPrefetch.ts`、`web/sw.ts`

相关决策：ADR-037（队列预载）、ADR-036（shuffle 排列游走，预载的顺序前提）

## 要构建什么

- 目标：在网络良好且播放侧空闲时，**主动**预热队列中相对当前曲**前后各 2 首**的音频 / 封面 / 歌词，使切歌、跳到下一首、回到上一首近乎瞬时、无封面闪。
- 音频由 Service Worker 自行整段下载写缓存（页面不接字节）；封面经 `<img>` 走既有 SW 封面通道；歌词入内存缓存。

## 行为

- 预期行为：
  - `prefetchTargets(queue, index)` 取偏移 `+1,-1,+2,-2`（按队列长度回绕），按 `keyOf` 去重、剔除当前曲。
  - 门控 `canPrefetch`：`!buffering` 且当前曲 `readyState ≥ 3` 且网络良好（`onLine`、非省流、非 `slow-2g/2g/3g`）。
  - 调度：`current/queue/index/level/buffering` 变化 → 重排预载；`settle 2500ms` 防抖（连跳不断重置），发车后经 `requestIdleCallback`（退化 `setTimeout`）**串行**、曲间 `gap 1500ms`。
  - 单首 `prefetchTrack`：音频 `postToServiceWorker({ type:'PREFETCH_AUDIO', … })`、封面 `preloadCover(coverAt(cover, px))`（SMALL + LARGE）、歌词 `prefetchLyric`。**先登记再执行**，幂等。
  - SW 收到 `PREFETCH_AUDIO`：命中缓存或同 key 在途 → no-op；否则整段下载写 IDB；**单飞**（新消息 abort 旧的）。
  - 登录 / 登出清缓存（ADR-034）时同步清空页面去重表。

## 输入 / 输出

- 输入：播放器队列状态（`queue` / `index` / `buffering`）、`audio.readyState`、`navigator.onLine` / `connection`、`settings.level`。
- 输出：SW 媒体缓存（音频 blob + 元数据）、SW 封面缓存（同一 IDB 池）、歌词内存缓存；均无用户可见 UI。

## 约束

- 音频落法为**消息式**（落法 B）：页面不接收字节，SW 自取；复用 `mediaCache` 的 `audioKey` 与 `sw.ts` 的 `storeResponse` / LRU。
- 预载请求**不带 Range**（SW 仅整文件可缓存）；URL 经 shared `streamUrl` 拼装。
- 预载路径**绝不** `notifyNeedLogin`（预载曲目尚未打算播放）。
- 去重键与 SW `audioKey` 同形（含 `level`）；去重表有界（512）。
- 纯函数（`prefetchTargets` / `isNetworkGood` / `canPrefetch` / `prefetchKey`）与协议校验（`parsePrefetchAudio`）不触浏览器 API，可单测。

## 边界条件

- 队列过短：`len 1→0，2→1，3→2，4→3，5→4`（回绕去重）。
- 队列内重复曲目：按 `keyOf` 去重。
- `index` 越界 / `-1`：目标为空 → `cancel()`。
- `repeat='one'`：不影响预载目标（仍预 ±2，用户仍可能手动切歌）。
- shuffle：只读 `queue`（已重排的排列），**绝不用 `baseQueue`**。
- 浏览器不支持 `connection` / `requestIdleCallback`：分别「视为良好」、退化 `setTimeout`。
- SW 未 controller（首载）：音频预载静默缺席，封面 / 歌词仍预。
- VIP / 版权（后端 403）/ 非整段音频：静默丢弃响应体、不缓存、不通知登录。

## 验收标准

- [x] `prefetchTargets`：长队列顺序、回绕、短队列去重、重复曲目、越界 —— `test/lib/prefetch.test.ts`。
- [x] `isNetworkGood` / `canPrefetch`：离线、省流、各 `effectiveType`、未知类型、缓冲、`readyState` —— 同上。
- [x] 去重表按 `level` 区分、上限淘汰、`clearPrefetchRegistry` —— 同上。
- [x] `prefetchTrack`：发消息 + 两档封面 + 歌词、幂等、换档重发 —— 同上。
- [x] `createPrefetchScheduler`：静置防抖、串行、`gate` 中途失效、重排取消、`cancel`、默认 `idle` 退化 —— 同上。
- [x] `parsePrefetchAudio` / `prefetchAudioMessage`：合法、档位归一、非法输入 —— `test/lib/prefetchProtocol.test.ts`。
- [x] `clearAllAppCaches` 清空预载去重表 —— `test/lib/clearCaches.test.ts`。
- [x] `pnpm typecheck` 与 `pnpm test` 零错误 / 全绿。

## 完成定义

- 如何判定已完成：单元测试覆盖各纯函数分支与调度器行为且全绿；手动在 DevTools 观察空转数秒后 IDB `pterosaur.mediaMeta` 出现 ±2 曲目条目、切歌近乎瞬时。
