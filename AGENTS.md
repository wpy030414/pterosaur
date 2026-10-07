# AGENTS.md

Pterosaur —— 仿 Apple Music 的网页音乐播放器（React 19 + Vite 前端，Hono 后端代理网易云音源）。本文件帮助 Agent 快速定位项目结构与约定；产品与架构细节见 `docs/`。

## 概述

- 本项目是什么：自托管网页音乐播放器。前端负责发现/搜索/播放体验，后端负责把网易云的搜索、元数据、歌词与音频流代理成同源接口，并在用户登录后透传会话以解锁 VIP 曲目。

## 边界与范围

- 范围内：
  - 前端播放体验（首页/浏览/电台/搜索/歌单/资料库/播放队列/全屏歌词）。
  - 后端 API 代理与音频串流（含 Range 分段）、网易云扫码登录与会话透传；以及**独立 MV 渠道**——B 站搜索 + 只解析其音频播放（见 ADR-033）；视频字幕作歌词，主语言非中文时叠加中文轨为翻译（需登录才拿得到字幕列表，见 ADR-035）。
- 非目标（明确排除）：
  - 不做纯静态部署——音频代理与登录必须有 Node 后端。
  - 不自建音源或存储音频文件，全部实时解析上游（网易云 / B 站）。
  - 不做多用户账号体系；**同一浏览器最多登录一个第三方账号**（单活动账号，见 ADR-027），登录态即用户本人的该平台会话，仅存于其浏览器 cookie。

## Agent 操作指南

- 如何理解本项目：
  - 先读 `docs/ARCHITECTURE.md` 建立整体结构认知，再读 `docs/DECISIONS.md` 了解关键技术选型原因（尤其是「为什么需要后端代理」）。
  - 前后端共享类型定义在 `packages/shared/`（`@pterosaur/shared`），改动数据模型时**必须同时考虑浏览器与 Node 两侧**。
- 全局规则 / 约定：
  - **同源代理铁律**：前端永远不直连上游域名；所有网络请求走 `/api/*` 与 `/stream/*`。新增音源能力时在后端加路由，前端只调本域接口。
  - **多源身份铁律**：实体（`Track`/`Artist`/`Album`/`Playlist`）都带 `source`；全仓所有「认曲 / 认实体」的判等一律用 `keyOf(e)`（`source:id`）而非裸 `id`——不同源可能共享同一原始 id。内容路由带 `:source` 段或 `?source=`，音频是 `/stream/:source/:id`（**均保留 2 段式别名**＝缺省源，兼容 SW 外壳 7 天缓存下的旧页面）；缓存键也带源前缀。新增音源 = 实现一个 `SourceAdapter` 并在 `apps/server/src/sources/index.ts` 注册（见 ADR-022）。扫码登录能力（`qrKey/qrCreate/qrCheck`）为**可选**——缺省即该源不支持登录，路由回 501、前端据 `LoginStatus.loginable` 隐藏登录入口。**源清单是双名单**：`MUSIC_SOURCES`（可浏览 / 身份 / 发现 / 单活动账号，现为 `netease`）与 `MV_SOURCES`（独立渠道，现为 `bilibili`）；后者不进 `activeSource`/`requireIdentity`，登录它不劫持首页与云同步（见 ADR-033）。
  - **音频地址必须 https**：上游可能返回 `http://` 音频地址，后端各适配器统一改写为 `https://`，不要在浏览器侧直接使用原始地址（会触发混合内容拦截）。
  - **封面 URL 必须规范化**：网易云封面/头像一律经 `@pterosaur/shared/image` 的 `canonicalNeteaseImage`——网易云会随机轮换 `p1`–`pN.music.126.net` 镜像主机，原始 URL 不稳定，否则以 URL 为键的缓存会被拆成多条（见 ADR-020）。**其它源**同理在本源适配器内规范化（B 站 `i0`–`iN.hdslb.com` → 固定主机，见 `sources/bilibili.ts`）；无法规范化或主机稳定的 CDN 原样返回。
  - **NeteaseCloudMusicApi 参数是扁平的**：如 `api.cloudsearch({ keywords, limit })`，不是嵌套 `{ query: {...} }`；其返回的 `cookie` 是「Set-Cookie 字符串数组」，透传逻辑见 `apps/server/src/sources/netease.ts`。
  - 状态管理：播放状态在 `apps/web/src/store/player.ts`，收藏/最近播放/本地歌单在 `library.ts`，登录态（**单活动账号**）在 `auth.ts`，云同步开关与锚点（跟随活动账号）在 `sync.ts`，音质/背景偏好（仅存轻量元数据）在 `settings.ts`，临时 UI（队列面板开合）在 `ui.ts`，翻录进度（仅存运行时）在 `rip.ts`。持久化：**`library` 走 IndexedDB**（`lib/libraryStorage.ts`，异步 + 写合并 + 旧 localStorage 一次性迁移，见 ADR-011），`player` / `sync` / `settings` / `theme` 走 localStorage；`ui` / `rip` 不持久化。改 `library` 时务必同步其 `partialize`——IDB 的 structured clone 不能克隆 action 函数。`player` 的 `shuffle` 是对队列的一次性洗牌，之后 `next`/`prev` 顺序游走（见 ADR-036）。
  - PWA / 缓存：`vite-plugin-pwa`（配置在 `apps/web/vite.config.ts`，`injectManifest`）把现有手写 SW（`apps/web/src/sw.ts`）作为**唯一** Service Worker 构建为 `sw.js`（IIFE）；`build` 就是单条 `vite build`，**已无第二步 SW 构建**。SW 承担三类互不相交的职责：`/stream/*` 音频与封面图片（`destination === 'image'`，CORS 拉取）写入**同一个** IndexedDB 池（共用 16GB LRU；逻辑在 `lib/mediaCache.ts`，低层封装 `lib/idb.ts`），生产下另经 Workbox 缓存应用外壳、**7 天过期**（`lib/shellCache.ts`）。IDB 库为 v4（`media`/`mediaMeta`/`background` + 独立的 `library` store）。PWA 生命周期操作（注销 / 清 Cache Storage / 硬刷新）在 `lib/pwa.ts`，均由顶栏设置弹窗调用。**登录 / 退出登录会清空全部缓存**（媒体池 + Cache Storage + 内存缓存，见 `lib/clearCaches.ts` 与 ADR-034），但**不动** `background` store（本地设置）。SW 另接受页面 `PREFETCH_AUDIO` 消息**主动**预热音频（预载队列相邻曲目；403 静默、不通知登录，见 ADR-037）。
  - 播放进度 seek 用 `apps/web/src/hooks/audioElement.ts` 的 `seekTo()` 命令式处理，**不要**直接写 store.position（会与音频回写打架）。
  - 样式：设计令牌集中在 `apps/web/src/styles/tokens.css`，组件样式与组件同名 `.css` 并排存放。新增颜色/间距优先用 CSS 变量。
  - 测试：单元/组件测试**镜像**在 `apps/web/test/**`（`src/` 下不放测试，`vitest.config.ts` 的 `include` 即此约定）；E2E 在根 `test/`（Playwright，需先 `pnpm build`）。改动核心播放逻辑（队列 / 循环 / 随机）必须补 `apps/web/test/store/player.test.ts` 用例。
  - 提交信息遵循 Conventional Commits：type/scope 用英文，描述用简体中文；作者为 `杏仁鹿 <krkr@xrl.im>`。

## 目录速查

- `apps/server/` — Hono 后端（`@pterosaur/server`）：`src/index.ts` 入口与静态托管，`src/app.ts` 路由，`src/sources/*` 音源适配器（`netease` / `bilibili`）与注册表，`src/syncStore.ts` / `syncDb.ts` / `syncEvents.ts` 云同步（嵌入式 SQLite + SSE），`tsup.config.ts` 为 tsup 构建配置。
- `apps/web/` — React 19 前端：`src/` 下为 SPA 源码，`vite.config.ts` 为 Vite 构建配置。
- `packages/shared/` — 前后端共享（`@pterosaur/shared`）：`src/types.ts` 数据模型与工具，`src/lyric.ts` LRC 歌词解析，`src/image.ts` 网易云封面 URL 规范化。
- `apps/web/src/api/` — 前端 API 客户端（`client.ts`）。
- `apps/web/src/store/` — Zustand 状态：`player` / `library` / `auth` / `sync` / `settings` / `ui` / `rip`。
- `apps/web/src/hooks/` — `useAudioEngine`（音频引擎）、`useKeyboardShortcuts`、`useTheme`、`useAsync`、`useNowPlayingPrefetch`（当前曲封面 / 歌词预载）、`usePlaylistPrefetch`（队列前后各 2 首预载）、`useLibrarySync`（云同步引擎挂载）、`useSourceTheme`（按源主题色）、`useAccentFromBackground`（自定义背景取色）、`useMediaQuery`（响应式门控）、`audioElement`（单例 audio 与 seek）、`useViewNavigate` / `useContentScrollRestoration` / `usePresence`。
- `apps/web/src/lib/` — 非组件工具：`idb`（低层 IndexedDB）、`coalesceWrites`（写合并）、`libraryStorage`（library 的 IDB 持久化）、`mediaCache`（音频 + 封面的媒体缓存与 LRU）、`prefetch`（队列预载调度器）、`prefetchProtocol`（SW 预载消息协议）、`shellCache`（应用外壳 7 天过期缓存）、`pwa`（注销 / 清缓存 / 硬刷新）、`sync`（云同步引擎）、`background`（自定义背景存取）、`accent`（背景取色）、`clearCaches`（凭证切换清缓存）、`reset`（整库重置）、`playbackWatchdog`（弱网播放韧性）、`nowPlayingTransition` / `viewTransition` / `themeTransition`（转场）、`scrollMemory`（滚动位置记忆）、`rip`（翻录下载）、`formatBytes`、`download`/`downloadPlaylist`。
- `apps/web/src/sw.ts` — 应用 Service Worker（音频 + 封面 IDB 缓存 + 生产下外壳 Workbox 缓存 + 接受 `PREFETCH_AUDIO` 消息主动预热音频；由 vite-plugin-pwa 构建为 `sw.js`）。
- `apps/web/src/components/` — UI 组件（Sidebar / Topbar / PlayerBar / NowPlaying / QueuePanel / TrackList / LoginModal 等）及其样式。
- `apps/web/src/pages/` — 路由页面（Home / Browse / Radio / Search / Playlist / Library / Favorites / Recent）。
- `apps/web/src/styles/` — 全局样式与设计令牌。
- `test/` — Playwright 端到端测试（根目录，需先 `pnpm build`）。
- `docs/` — PRD / ARCHITECTURE / DECISIONS / specs。
