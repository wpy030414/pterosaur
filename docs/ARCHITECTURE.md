# ARCHITECTURE — Pterosaur

## 系统概述

Pterosaur 分三层：浏览器前端（React SPA）、同源 Hono 后端（API + 音频代理）、上游服务（网易云 / B 站）。前端从不直连上游，所有外部数据都经后端代理，从而规避浏览器的跨域与 `http://` 混合内容限制，并在登录态下透传会话以解锁 VIP。

```
┌───────────────────────────────────────────────────────────────┐
│ 浏览器 (React 19 SPA)                                           │
│                                                                 │
│  pages/ ──► components/ ──► store (zustand)                     │
│                                  │                              │
│                    hooks/useAudioEngine  ◄── <audio> 单例        │
│                                  │                              │
│                    api/client.ts（fetch，同源）                  │
└──────────────┬───────────────────────────────┬─────────────────┘
               │ /api/*  (JSON)                │ /stream/:source/:id (音频, Range)
               ▼                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Hono 后端 (@hono/node-server)  —— 生产下同时托管 dist/ 静态资源   │
│                                                                 │
│  app.ts (路由)  ──► sources/netease.ts / bilibili.ts             │
│                         │                                       │
│                    lru-cache（音频地址/音质 15min；结构化数据 2h）│
│                    node:sqlite（云同步存储，WAL）               │
└──────────────┬──────────────────────────────────────────────────┘
               ▼
   NeteaseCloudMusicApi ──► 网易云音乐上游
   自研 B 站适配器       ──► B 站 API（搜索 / dash.audio / 字幕 / 登录）
```

开发期由 Vite 把 `/api`、`/stream` 代理到后端（`vite.config.ts`）；生产期由同一 Hono 进程既发静态资源又发 API（`server/index.ts`），始终单一同源。

## 核心模块

| 模块                                       | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/app.ts`                            | 定义全部 HTTP 路由：搜索（单曲 + 多类型 `/api/search/all`）、艺人 / 专辑详情、发现（`/api/discover/*?source=`）、歌单、歌词、**音质查询（`/api/quality/*`，实际解析结果）**、登录、**云同步**、音频流代理；统一 `ApiResult` 包裹与错误处理。**多源**：内容与发现路由带 `:source` 段或 `?source=`（默认网易云），登录路由 `/api/auth/:source/*`，音频 `/stream/:source/:id`（均保留 2 段式别名）                                                                                                                       |
| `server/sources/*`                         | **音源适配器**：`types.ts` 定义 `SourceAdapter` 接口（必选核心 + 可选能力，含发现 `recommendPlaylists/toplists/topPlaylists`；音质查询 `audioQuality`、扫码登录 `qrKey/qrCreate/qrCheck` **亦为可选**，缺省即「该源无此能力」，路由回 501、前端隐藏对应入口）；`netease.ts` 封装 `NeteaseCloudMusicApi`；`bilibili.ts` 为自研 B 站适配器（**MV 渠道，只放音频**，见 ADR-033；`getLyric` 把视频字幕当歌词——主语言非中文时叠加中文轨为翻译，需登录，见 ADR-035）；`index.ts` 注册表（`adapterOf`）。实体一律带 `source` |
| `server/syncDb.ts`                         | 云同步的**嵌入式 SQLite 存储层**（`node:sqlite`）：库 `<DATA_DIR>/sync.db`、表 `sync_docs(key, state, rev, updated_at)`（WAL），首次打开把旧 `sync/*.json` 迁入（见 ADR-038）                                                                                                                                                                                                                                                                                                                                         |
| `server/syncStore.ts`                      | 云同步的**对外持久化 API**（形状校验 / 体积上限 / `userId` 净化），委托 `syncDb`；按访客本人的**活动账号** `<source>-<账号id>` 隔离（见 ADR-028）。**版本 `rev` 与 `updatedAt` 由服务端指派**（见 ADR-038）                                                                                                                                                                                                                                                                                                           |
| `server/syncEvents.ts`                     | 云同步的 **SSE 订阅注册表**（进程内）：按账号分组，`broadcast(key, { rev })` 向其它连接推版本信号（见 ADR-038）                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server/index.ts`                          | 服务入口：生产模式挂载静态资源与 SPA 回退，启动 HTTP 服务                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `shared/types.ts`                          | 前后端共享的数据模型（Track/Artist/Album/Playlist/Lyric/LoginStatus/ApiResult/SearchResults/LocalPlaylist/LibraryData/SyncEnvelope）与工具（formatTime/**sourceOf/keyOf/isMusicSource**/streamUrl/**streamUrlOf**/**AudioLevel/AUDIO_LEVELS/AudioQuality/formatQuality**）；实体带 `source`，`keyOf(e)=`${sourceOf(e)}:${e.id}`` 是全仓统一身份（见 ADR-022）                                                                                                                                                         |
| `shared/lyric.ts`                          | LRC 歌词解析：时间戳展开、排序、翻译对齐                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `shared/image.ts`                          | 图片 URL 规范化与分档：`canonicalNeteaseImage`（网易云随机镜像主机去重，见 ADR-020）、`coverAt(url, px)` 与 `COVER_SMALL`/`COVER_LARGE`/`COVER_RIP`（按场景选画质：网易云改 `param`，见 ADR-031；翻录封面取 `COVER_RIP=3000`（母带上限）；其它 CDN 原样返回）                                                                                                                                                                                                                                                         |
| `src/api/client.ts`                        | 前端 fetch 封装，解析 `ApiResult`，抛带 `needLogin` 的错误                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/store/player.ts`                      | 播放核心状态机：队列、当前曲目、循环/随机、音量、进度；含持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/store/library.ts`                     | 收藏曲目、最近播放、本地自建歌单、收藏的网易云歌单 / 艺人 / 专辑；持久化到 **IndexedDB**（见 ADR-011）                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/lib/idb.ts`                           | 低层 IndexedDB 封装（主线程与 SW 共用；`indexedDB` 不可用时优雅降级）                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/coalesceWrites.ts`                | 微任务级写合并的 `PersistStorage` 装饰器（同一 tick 内多次写入只落最后一次）                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/lib/libraryStorage.ts`                | library 的 IDB `PersistStorage` + 旧 localStorage 数据一次性迁移                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/lib/mediaCache.ts`                    | 媒体缓存领域逻辑（音频 + 封面：缓存 key / Range 切片 / LRU 计算 / **封面 7 天过期判定**）+ IDB 存取（主线程与 SW 共用）（见 ADR-015）                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/shellCache.ts`                    | 应用外壳（导航 HTML + 同源 script/style）的 Workbox 运行时缓存，**7 天过期**（见 ADR-013）                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/lib/pwa.ts`                           | PWA 生命周期操作：注销 SW、清 Cache Storage、硬刷新（设置弹窗「检查更新」）                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/lib/reset.ts`                         | 「重置」：清空本机全部内容（IDB store / Cache Storage / SW 注册 / Web Storage）并刷新，**不动登录态**                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/formatBytes.ts`                   | 字节数转人类可读字符串（设置弹窗展示缓存用量）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/lib/sync.ts`                          | library 云同步引擎：**云端权威**（`syncOnEntry`，云端为空则本地为准并上传）、载荷快照、订阅变更防抖推送、回声抑制、**SSE 实时通道**（`startEventStream`，断开 5s 重连、永不停止）（见 ADR-038）                                                                                                                                                                                                                                                                                                                       |
| `src/lib/rip.ts`                           | 翻录（打包下载）任务：全局单任务 + 并发守卫，进度写入 rip store；下载在后台继续、不随组件卸载中止                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/playbackWatchdog.ts`              | 弱网播放韧性纯逻辑：停滞看门狗（静默判定 / 退避 / 恢复预算 / 未起播不介入）与「截断流」提前结束判定（见 ADR-021）                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/sw.ts`                                | 应用 Service Worker：`/stream/*` 音频与封面图片（CORS 拉取）写入**同一个** IDB 池（共用 16GB LRU；封面 7 天过期）；生产下另经 Workbox 缓存应用外壳（见 ADR-012 / ADR-013 / ADR-015）                                                                                                                                                                                                                                                                                                                                  |
| `src/store/auth.ts`                        | 登录态（按源）；**单活动账号**：最多一个源登录（`activeSource`），登录后无登录入口、只有退出（见 ADR-027）                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/store/sync.ts`                        | 云同步开关与记账（`enabled` / 绑定的活动账号 `source`+`accountId` / 已知云端版本 `rev`），持久化到 localStorage。**登录后默认开启**（见 ADR-038）；**锚点跟随活动账号**（见 ADR-028）                                                                                                                                                                                                                                                                                                                                 |
| `src/store/rip.ts`                         | 翻录进度的全局状态（`job`：合集 key + 已处理/总数），不持久化；页面按 key 认领，切换页面不丢失                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/store/settings.ts`                    | 应用偏好（`level`：**统一抽象音质档**；设置界面收敛为「一般 / 质量」两档，见 ADR-041），持久化到 localStorage；播放 / 下载据此按档取流（见 ADR-031）                                                                                                                                                                                                                                                                                                                                                                  |
| `src/store/ui.ts`                          | 临时 UI 状态（队列面板开合等），不持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/hooks/useAudioEngine.ts`              | 全局唯一 `<audio>` 的驱动：换源、播放/暂停、事件回写、结束推进、媒体会话                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/hooks/useLibrarySync.ts`              | 挂载 library 云同步引擎：开关 + 登录态满足时激活（进入即一次同步 + 订阅变更防抖推送 + 打开 SSE），在 `App` 顶层调用                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/AppRouter.tsx`             | 自定义路由器（替换 `<BrowserRouter>`）：把**所有**历史变更（含 popstate 前进 / 后退）统一包进内容区 View Transition，并按方向正放 / 逆放动画（见 ADR-040）                                                                                                                                                                                                                                                                                                                                                            |
| `src/lib/background.ts`                    | 自定义应用背景的媒体本体存取（IDB 专用 `background` store + object URL 进程内缓存）（见 ADR-039）                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/accent.ts`                        | 从背景媒体取平均色并派生 `--accent*` 四档（`deriveAccent` / `accentFromBlob`）（见 ADR-039）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/hooks/useBackgroundUrl.ts`            | 当前背景的 object URL（异步从 IDB 载入）（见 ADR-039）                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/hooks/useAccentFromBackground.ts`     | 依背景取色覆写 `--accent*`（仿 `useSourceTheme` 的 JS 覆写 CSS 变量）（见 ADR-039）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/AppBackground.tsx`         | 应用背景层（`.app-shell` 内的负 z-index 层，排除底部播放条；有背景时在 `<html>` 打 `data-has-bg`）（见 ADR-039）                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/hooks/audioElement.ts`                | audio 单例引用与命令式 `seekTo()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/hooks/useAsync.ts`                    | 通用取数钩子；可选 `cacheKey` 提供模块级内存缓存（命中即同步返回，参数切换免加载态）                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/hooks/usePresence.ts`                 | 让浮层在关闭后继续挂载以播放退出动画                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/hooks/useContentScrollRestoration.ts` | 按历史条目恢复 `.app-content` 滚动位置（布局期恢复 + 次帧补一次），在 `App` 顶层调用                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/hooks/useViewNavigate.ts`             | 包装 `useNavigate`，使路由跳转经内容区转场                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/lib/viewTransition.ts`                | 内容区转场：自实现 `document.startViewTransition`（含浮层 / 减少动效 / 不支持时的降级判断）                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/lib/scrollMemory.ts`                  | 内容区滚动位置记忆：以 `location.key` 为键（前进新 key 归零、后退恢复）                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/components/*`                         | UI 组件（Sidebar/Topbar/PlayerBar/NowPlaying/QueuePanel/TrackList/EntityCards/AppLink/LoginModal/**SettingsDialog** 等）                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/pages/*`                              | 路由页面：Home/Browse/Radio/Search/Playlist/**Artist**/**Album**/**Crate（唱片盒：收藏的艺人 + 专辑）/Favorites/Recent                                                                                                                                                                                                                                                                                                                                                                                                |

## 模块关系

- 页面（`pages/`）通过 `api/client.ts` 取数、通过 `store` 读写状态、通过 `components/` 渲染。
- 所有「播放」动作最终都落到 `store/player.ts`；`useAudioEngine` 是 store 与真实 `<audio>` 之间的唯一桥梁，单向把 store 意图翻译成音频操作，并把音频事件回写 store。
- 进度 seek 是唯一例外：由 `audioElement.seekTo()` 同时写 audio 与 store，避免 rAF 回写与用户拖拽互相覆盖。
- `shared/` 被前后端同时引用，是数据契约的单一来源；改模型需两侧同步。

## 数据流

**搜索（多类型）：**

1. 用户在 Topbar 搜索 → 导航到 `/search?q=` → `Search` 页调 `api.searchAll(q)`。
2. 后端 `/api/search/all` 并行调用 `netease` 的 `searchSongs / searchArtists / searchAlbums / searchPlaylists`（`cloudsearch` 类型码 1/10/100/1000）→ 归一化为 `{songs, artists, albums, playlists}`（封面改写 https）。
3. 四个 tab 分类展示；点击艺人 / 专辑卡片进入 `/artist/:id`、`/album/:id`（`api.artist` / `api.album`）。

**播放一首歌（搜索场景）：**

1. 用户在搜索结果或任意列表点击曲目行 → `TrackList` 调 `player.playTracks(tracks, i)`，写入队列与当前曲目。
2. `useAudioEngine` 侦测 `current` 变化 → 设 `audio.src = /stream/:source/:id` → `audio.play()`。
3. 浏览器请求 `/stream/:source/:id` → 若已被 **Service Worker** 缓存，则直接由 IDB 按 `Range` 切片返回（离线可播；seek 型 `Range` 不经 SW、由浏览器直接请求同源接口，离线时仅能在已缓冲区间跳转，见 ADR-012 后续修订）；否则经后端代理拉取：后端按源分派适配器解析真实地址（带缓存、https 改写）按 Range 转发上游 CDN；SW 把整文件响应写入 IDB 供后续播放（见 ADR-012）。
4. `audio` 的 durationchange/ended/error 等事件回写 store（进度、自然结束推进、播放受限提示）；`waiting`/`stalled` 与 `canplay` 回写缓冲态，弱网停滞由看门狗恢复（见 ADR-021）。

**封面图片（与音频共用缓存）：**
`<img>` 向网易云 CDN 请求封面 → SW 按 `destination === 'image'` 接管：命中 IDB 直接返回；未命中以 **CORS** 重新拉取（CDN 返回 `access-control-allow-origin: *`）取到**可读**字节，写入与音频**同一个** IDB 池（共用 16GB LRU）；失败则原样放行、不缓存（见 ADR-013）。

**应用外壳（离线可用，7 天过期）：**
生产下 SW 另经 Workbox 缓存应用外壳——导航 HTML 走 `NetworkFirst`、同源 script/style 走 `StaleWhileRevalidate`，均带 7 天 `ExpirationPlugin`；precache 仅含静态图标与 manifest（见 ADR-013）。

**内容区转场 / 沉浸播放页：**

1. 导航（`useViewNavigate` / `AppLink`）经 `startRouteTransition`：支持且无浮层时用 `document.startViewTransition` + `flushSync` 提交路由更新，CSS 让 `.app-content` 交叉溶解；否则直接跳转（Firefox 走 `.route-stage` 的 CSS 降级进场）。
2. 进入 / 退出沉浸播放页由 `player.expanded` 驱动，走 `lib/nowPlayingTransition.ts` 的 `startNowPlayingTransition`：支持 View Transitions 时以**共享元素**方式让小封面（`np-cover`）morph 成大封面，背景 / 面板用 live CSS 动画淡入上浮；转场期间 `<html>` 打 `data-np-vt` 摘掉 `.app-content` 的命名（避免闪白 + 盖层）。`NowPlayingLayer`（`App.tsx`）在 VT 能力存在时**同步挂卸**（`show = expanded`），仅在完全不支持 VT 时退回 `usePresence` 延迟挂卸 + `np-enter`/`np-exit` 上滑。详见 ADR-018。
3. 预载：`hooks/useNowPlayingPrefetch` 在当前曲目变化时预热封面（decode，`lib/imageCache.ts` 登记就绪 URL）与歌词（`lib/lyricCache.ts` 内存缓存），使打开瞬时、无占位闪、无「歌词加载中」停留。沉浸页歌词的首 / 末行居中留白由 `::before`/`::after` 撑起（JS 写 `--np-lyric-pad`），**不得**改成容器 `padding`——那会每次换行重设滚动容器的盒模型、顶动下方控制区（见 ADR-041）。

**登录解锁 VIP：**

1. 打开 `LoginModal` → `api.qrCreate` 取 key + 二维码图片。
2. 前端每 2s 轮询 `api.qrCheck(key)`；后端调网易云 `login_qr_check`。
3. 状态 803（成功）时，后端从网易云返回的 Set-Cookie 中挑出会话必需的几项（`MUSIC_U`、`__csrf`、`MUSIC_A`、`NMTID`）下发浏览器，并返回登录档案；网易云会附带数十条无关 cookie，全量下发会撑大响应头（网关缓冲超限时被 502 截断）。
4. 此后浏览器请求自动带 cookie，后端 `cookieOf()` 提取并透传给网易云，VIP 曲目即可解析出音频地址。

**缺省凭证（未登录访客）：**

1. 部署者运行 `pnpm log-in [netease|bilibili]`（缺省 `netease`）：终端直接打印二维码，用对应 App 扫码；成功后把会话 cookie 写入仓库根 `.env` 的 `NETEASE_COOKIE` / `BILIBILI_COOKIE`（另有 `pnpm log-in:bilibili` 快捷脚本）。
2. 服务启动时 `loadEnv()` 注入 `process.env`；内容接口取 `credentialOf(c) = 访客 cookie ?? NETEASE_COOKIE`，故匿名访客也能解析 VIP（见 ADR-014）。
3. 身份接口（`/api/auth/status`、`/api/user/playlists`）仍只用访客 cookie——匿名访客依旧显示「未登录」，登录后以本人凭证优先。

**封面缓存过期（7 天）：**
封面写入 IDB 时记录 `cachedAt`（写入时刻）。SW 命中时若 `now - cachedAt ≥ 7 天` 则清除并按未命中回源重取；SW 启动（`loadState`）时顺带清扫一遍过期项。音频不设时间过期，仅受 LRU 淘汰（见 ADR-015）。

**队列预载（前后各 2 首）：**
`hooks/usePlaylistPrefetch` 订阅当前曲 / 队列 / 下标 / 音质档位；在网络良好（`navigator.onLine` + Network Information API，非省流）、当前曲未缓冲且 `readyState ≥ 3` 时，经 `lib/prefetch.ts` 的调度器（`requestIdleCallback` 串行、`settle` 防抖、曲间留隙）预热队列**前后各 2 首**的音频 / 封面 / 歌词。音频由 `lib/prefetchProtocol.ts` 的 `PREFETCH_AUDIO` 消息交 SW 自行整段下载写 IDB（403 静默、不通知登录）；封面取 `COVER_SMALL` + `COVER_LARGE` 两档、经既有 SW 封面通道；歌词入内存缓存。`current`/`queue`/`index`/`level` 变化即取消重排；登录 / 登出清缓存（ADR-034）时同步清空页面去重表（见 ADR-037）。

**library 云同步（云端权威 + SSE）：**

1. **登录后默认开启**（`finishQrLogin` → `store/sync.ts` 记 `enabled` 与绑定的**活动账号** `source`+`accountId`）；也可在头像菜单手动开关。
2. 进入同步启用态（登录 / 开开关 / 打开页面）触发 `syncOnEntry()`：拉取云端；**有数据即以云端覆盖本地**（`applyPayload`，期间抑制回声），**云端为空则以本地为准并上传**（见 ADR-038）。
3. `useLibrarySync` 激活期间订阅 `useLibrary` 变更 → 防抖约 1.5s 推送（服务端指派新 `rev`）；并打开 `GET /api/sync/events` 的 SSE：其它设备收到 `{ rev }` 且比本机已知版本新时重拉并应用；断开每 5s 重连、永不停止。失活 / 换账号自动退订并关闭 SSE（见 ADR-038）。

**设置重置：**
`SettingsDialog` 的「重置」经二次确认后，先（若云同步已开启）推送空 library 清空云端副本，再 `resetAll()`：清空 `library` / `media` / `mediaMeta` / `background` 四个 IDB store、Cache Storage、SW 注册与 localStorage / sessionStorage，最后整页刷新；**不动登录 cookie**，故仍处登录态。

## 配置（环境变量）

- 读取点全在服务端与构建脚本；前端源码不含自定义变量（仅 Vite 内置 `import.meta.env.PROD`）。
- 服务端启动时先 `loadEnv()` 读取**仓库根 `.env`**（存在才读），为下列变量提供值；注意 **同名环境变量优先于 `.env`**（`process.loadEnvFile` 不覆盖已有的 `process.env`）。变量一览：

| 变量                        | 默认值                           | 用途                                                                                                                                                           |
| --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETEASE_COOKIE`            | 空                               | 缺省网易云会话，由 `pnpm log-in` 写入；为空则无缺省凭证（见 ADR-014）。                                                                                        |
| `NETEASE_COOKIE_UPDATED_AT` | 空                               | 上述凭证的写入时间（ISO），仅供人读。                                                                                                                          |
| `BILIBILI_COOKIE`           | 空                               | 缺省 B 站会话（`SESSDATA` 等），由 `pnpm log-in:bilibili` 写入；供匿名访客解析更高码率的 MV 音频、并解锁**字幕歌词**（B 站未登录不返回字幕列表，见 ADR-035）。 |
| `PORT`                      | `8788`                           | 后端监听端口（`API_PORT` 可作次选回退）。                                                                                                                      |
| `HOST`                      | `0.0.0.0`                        | 后端监听地址。                                                                                                                                                 |
| `DATA_DIR`                  | `<仓库根>/.data`                 | 云同步数据目录（**SQLite 库 `sync.db`**；旧 `sync/<source>-<账号id>.json` 首次打开时迁入）；已在 `.gitignore` 忽略（见 ADR-038 / ADR-028）。                   |
| `API_PORT` / `API_TARGET`   | `8788` / `http://127.0.0.1:8788` | 仅开发期 Vite 代理目标。                                                                                                                                       |
| `NODE_ENV`                  | —                                | `production` 时同源托管 SPA 静态资源。                                                                                                                         |

## 外部系统

- **NeteaseCloudMusicApi（npm 依赖）**：在 Node 进程内以函数形式调用网易云加密接口，是本后端的主要上游能力来源。
- **网易云音乐上游**：搜索/歌单/歌词接口，以及 `music.126.net` 音频 CDN。
- **B 站上游（非官方接口）**：搜索走 `x/web-interface/search/all/v2`，取流走 `x/player/playurl(fnval=16) → dash.audio`，字幕走 `x/player/wbi/v2`。音频直链为 `*.bilivideo.*` 上的明文 m4s；**必须带 `Referer: https://www.bilibili.com`**。
- 音频地址有时效，后端用 `lru-cache`（TTL 15 分钟）按 `源|id|档位|凭证指纹` 缓存解析结果。

## 重要技术边界

- **同源边界**：前端只访问本域 `/api`、`/stream`；绝不出现网易云域名。这是规避 CORS/混合内容的根本手段。
- **https 边界**：网易云音频/封面返回 `http://`，后端统一改写为 `https://`（`netease.ts` 的 `https()`），保证在 https 站点上可用。
- **会话边界**：登录态是用户本人的网易云 cookie，仅存于其浏览器；后端无状态，不持久化任何**用户**凭证（唯一例外是运营者可选持久化的缺省凭证，见下条与 ADR-014）。
- **缺省凭证边界**：服务端可用 `.env` 的 `NETEASE_COOKIE` / `BILIBILI_COOKIE` 作为未登录访客的缺省凭证，**仅用于内容解析**（搜索 / 播放 / 歌词等），绝不参与身份判断（见 ADR-014）。
- **后端持久化边界**：后端**默认为无状态**——除音频地址的短期 LRU 缓存（重启即恢复）外不保存业务状态。**两个可选例外**：(1) ADR-014 的缺省凭证（`.env`）；(2) ADR-016/038 的云同步——开启后服务端按**访客本人的活动账号** `<source>-<账号id>` 把 library 持久化到 `<DATA_DIR>/sync.db`（嵌入式 SQLite，见 ADR-038）。云同步使「多实例水平扩展」不再成立（SQLite 不共享），且 `.data/` 不入库。
- **云同步边界**：`/api/sync/library`（读 / 写）与 `/api/sync/events`（SSE）均为**身份接口**——身份只取访客本人 cookie，**绝不回退缺省凭证**；未登录 401。冲突策略为**云端权威**（进入即以云端覆盖本地，云端为空则以本地为准并上传；`rev` / `updatedAt` 由服务端指派），仅在「开关开启 且 已登录 且 账号与开启时绑定一致」时激活；多设备经 SSE 近实时同步（见 ADR-038）。
- **重置边界**：设置「重置」清空**本机**全部内容（IDB store + Cache Storage + SW 注册 + Web Storage）并整页刷新，**不清登录 cookie**（故仍登录）；因 SW 常驻持有 IDB 连接、`deleteDatabase` 会被阻塞，故以逐 store `clear()` 实现。若云同步已开启，先推送空 library 清空云端副本（顺序不可颠倒）。
- **封面过期边界**：媒体缓存中仅**封面**按固定 TTL 7 天过期（从写入时刻 `cachedAt` 起算，与外壳 7 天策略对齐）；缺 `cachedAt` 的旧封面判为过期并平滑刷新；音频不设时间过期，仅受 LRU 淘汰（见 ADR-015）。
- **共享类型边界**：`shared/` 不得引入 DOM 或 Node 专有 API，确保浏览器与 Node 两侧都能编译。
- **静态托管边界**：生产必须运行 Node 后端（`pnpm start`），不能当纯静态站点部署——音频代理与登录都依赖它。
- **数据契约兼容边界**：`Track.artistRefs` / `albumId` 为可选字段，旧的持久化数据（收藏 / 最近播放 / 队列）可能缺失，界面须降级为纯文本，不得假定其存在。
- **转场边界**：项目用声明式 `<BrowserRouter>`，react-router 内置 `viewTransition` 在此不生效；内容区转场由 `src/lib/viewTransition.ts` 自实现。只给 `.app-content` 设 `view-transition-name`，`:root` 置 `none`；有浮层打开 / 减少动效 / 不支持 API 时跳过或降级（见 ADR-008）。
- **滚动恢复边界**：内容区滚动位置以 `location.key` 为键记忆（`lib/scrollMemory.ts` + `hooks/useContentScrollRestoration.ts`）。**前进**（下钻 / 侧边栏 / 新开链接）得到新 key → 回到顶部；**后退 / 前进**（POP）复用旧 key → 恢复原位置。故「同页下钻再返回」回到原处，而「从侧边栏新开」从头开始。容器为内部滚动的 `.app-content`（不受浏览器窗口滚动恢复影响）；新增可滚动区域须沿用该容器或为其补对应恢复逻辑。
- **浮层订阅边界**：高频 / 开合型状态（如 `player.expanded`）**不要**在 `App` 顶层订阅——`App` 一重渲染会带整棵应用树（含当前路由页）一起重渲染，移动端开合有可感卡顿。沉浸播放页的开合由独立的 `NowPlayingLayer` 订阅 `expanded` 驱动。
- **移动端沉浸页性能边界**：`.nowplaying` 整块上推滑入期间，全屏 `backdrop-filter` 会逐帧重采样背景、背景层 `blur(80px)` 栅格化偏重；移动端（≤860px）降档为「scrim 纯色叠层 + 背景 `blur(40px)`」。改动这两处需回归移动端开合流畅度。
- **沉浸页交互边界**：沉浸页**恒定**「封面 + 封面模糊背景」，**不**受自定义应用背景影响（ADR-041，部分修订 ADR-039）。移动端封面可点按切换「专注歌词」（`nowplaying--focus`：缩小封面 + 收起歌名 / 歌手与播放控制组，仅留头部 / 小封面 / 歌词 / 进度），仅 `(max-width: 860px)` 生效、由 `hooks/useMediaQuery` 门控——断点常量须与 CSS 同步；封面尺寸另受 `min(64vw, 320px, calc(100svh - 300px))` 约束（用 `svh` 而非 `dvh`，否则滚动歌词时地址栏收放会让封面缩放、控制区漂移），矮屏下自动收窄以免把进度 / 控制顶出视口；inner 以 `env(safe-area-inset-bottom)` 为控制组留安全区。顶部**不再有「正在播放」标语**，改为如实展示音频流参数（`formatQuality` 渲染后端 `/api/quality/*` 的**实际**解析结果，含降级）；该源未实现 / 解析失败时不渲染，绝不阻塞播放。
- **毛玻璃前缀顺序边界**：CSS 压缩会丢弃未加前缀的 `backdrop-filter`，所有毛玻璃规则必须 `-webkit-backdrop-filter` 在前、`backdrop-filter` 在后（见 ADR-009）。
- **缩略参数边界**：给网易云图片追加 `param=WxH` 必须走 `thumb()`，兼容地址已带查询串的情况（见 ADR-010）。
- **客户端持久化边界**：`library` 走 **IndexedDB**（异步写入不阻塞主线程；structured clone 免 `JSON.stringify`；配合 `partialize` 只存数据字段，避免克隆 action 函数）；写入经微任务级合并节流（无定时 debounce 的丢写窗口）。**自定义应用背景**的媒体本体也在 IDB 的专用 `background` store（见 ADR-039）。`player` / `theme` / `sync` / `settings` 的 payload 小，仍用 localStorage（`sync` 仅存开关 / 绑定账号 / 已知云端版本 `rev`；`settings` 存音质档位与背景的轻量元数据）。library 的 hydration 是**异步**的，`main.tsx` 在首帧前 `await rehydrate()` 以避免空态闪烁（见 ADR-011）。
- **播放韧性边界**：网络差时引擎把故障显式化并自愈——`waiting`/`stalled` 置 `buffering`（播放键显示加载态）；**未起播**由 12s 起播超时兜底，**已在播的停滞**由看门狗（静默 5s 判定、退避 10/15/20s、最多 3 次）以 `load()` + 回拨位置恢复，预算耗尽则**暂停并提示、不自动跳歌**；`ended` 时若 `audio.duration` 比元数据时长短 >10s 且 >10%，判为「截断流」走同一恢复而非切歌。登录引导只由**后端 403 经 SW `postMessage`（`STREAM_NEED_LOGIN`）**驱动——音频元素的 `error` 事件无法区分网络失败与版权受限，故一律中性提示（见 ADR-021）。
- **SW 缓存边界**：Service Worker 按匹配范围互不相交地承担三类职责——(1) `/stream/*` 音频：整文件请求（无 `Range` / `bytes=0-` 前缀）命中按 `Range` 从 IDB 返回，未命中则单次下载、一路流式返回、一路写 IDB；seek 型 `Range` 不经 SW、由浏览器直接请求同源接口（见 ADR-012 后续修订）；(2) 封面图片（`destination === 'image'`）：命中即返，未命中以 CORS 拉取可读字节写入**同一** IDB 池，与音频共享 16GB LRU，且封面自写入起 **7 天过期**；(3) 应用外壳（仅生产）：Workbox 运行时缓存，7 天过期。音频/封面的容量上限为 `min(16GB, 配额 * 0.9)`，超出按 LRU 淘汰；仅缓存完整音频响应（`200`，或部分 CDN 对无条件请求返回的全量 `206`）且 `content-type` 为 `audio/*`；切片 `206`、`403`（VIP 未登录）/`502` 直接放行不缓存。封面 CORS 失败时回退直连且不缓存。`/api/*` 及其它请求原样放行（见 ADR-012 / ADR-013）。此外 SW 接受页面消息 `PREFETCH_AUDIO` **主动**整段下载某曲音频写 IDB（预载相邻曲目；命中 / 在途即 no-op；403 静默、不通知登录；SW 自身发起的 `fetch()` 不经其自身 fetch 处理器，故不递归，见 ADR-037）。
- **预载边界**：队列预载只在**网络良好且播放侧空闲**时进行——`onLine` + 非省流 + 非慢速类型、`!buffering` 且当前曲 `readyState ≥ 3`，并经 `requestIdleCallback`（退化 `setTimeout`）**串行**、`settle` 防抖、曲间留隙，避免与当前曲首缓冲抢带宽；音频经 SW 消息、封面经 `<img>`、歌词入内存，三者共用既有缓存层。预载的目标是「可能被跳过」的曲目，故 403 静默、失败本会话不重试、清缓存时须同步清页面去重表（见 ADR-037）。
- **播放顺序边界**：`shuffle` 是对队列的一次性 Fisher–Yates 洗牌；此后 `next`/`prev` 与自然结束推进一律**顺序游走**（`index±1`，越界按 `repeat` 回绕/停止），不再每次随机——保证整列不重复、手动切歌与自然推进一致、且顺序可预测（见 ADR-036）。
