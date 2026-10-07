# Spec — 多源架构（网易云 + 磁带渠道 B 站）

对应模块：`shared/types.ts`、`server/sources/{types,netease,bilibili,index}.ts`、`server/app.ts`、`server/cli/login.ts`、`web/store/{auth,library,player}.ts`、`web/sw.ts`、`web/lib/{mediaCache,lyricCache,idb}.ts`、`web/pages/*`、`web/components/*`

相关决策：ADR-022（多源架构）、ADR-025（缓存键加源）、ADR-026（搜索分组）、**ADR-033（移除 QQ / 咪咕、引入磁带渠道）**、**ADR-044（磁带：类歌单化、磁带卡、数量 chip）**。

## 要构建什么

- 目标：保留「实体带 `source` + `keyOf` 统一身份」的多源地基，但**音乐源仅保留网易云**；另设一个**独立磁带渠道**（B 站），在搜索页「歌曲」右侧提供「磁带」分类 tab——**搜索视频、只解析其音频**播放（B 站是 DASH 音视频分轨，取 `dash.audio` 即可）。**每条搜索结果即一盘「磁带」**——一个类歌单的合集（`source:'bilibili'` 的 `Playlist`）：可整盘播放、可进详情页选分P、可像歌单一样收藏到资料库（见 ADR-044）。
- 交互形态：搜索页分类 tab 为「歌曲 / 磁带 / 艺人 / 专辑 / 歌单」，**磁带与音乐结果并行取齐**；不再单列「源 tab」（只有一个音乐源）。登录弹窗列出**支持登录的源**（网易云 / 哔哩哔哩，均为扫码）。

## 行为

- 预期行为：
  - **实体身份**：`Track`/`Artist`/`Album`/`Playlist` 均带 `source`；全仓以 `keyOf(e) = \`${sourceOf(e)}:${e.id}\`` 认曲/认实体。`sourceOf`对缺失`source`的旧数据回填`'netease'`。
  - **源清单双名单**（`shared/types.ts`）：`MUSIC_SOURCES = ['netease']`（可浏览 / 身份 / 发现 / 单活动账号）、`CASSETTE_SOURCES = ['bilibili']`、`ALL_SOURCES = [...MUSIC_SOURCES, ...CASSETTE_SOURCES]`、`MusicSource = (typeof ALL_SOURCES)[number]`；`isMusicSource` 在 `ALL_SOURCES` 上判定。
  - **音频流**：`streamUrl(source, id)` → `/stream/:source/:id`；后端按源分派适配器解析真实地址（带 15 分钟 LRU，键含源与凭证指纹），https 改写 + Range 转发。**保留 2 段式 `/stream/:id` 别名**（视为缺省源）。
  - **响应 Content-Type 依直链后缀回写**：`app.ts` 的 `audioContentTypeFromUrl` 按解析 URL 后缀纠正上游谎报（网易云 `.flac` 谎称 `audio/mpeg`、B 站 `.m4s` 为 `application/octet-stream`），使下载落正确后缀、SW 能按 `audio/*` 入缓存。
  - **内容路由**：`/api/search`、`/api/search/all`、`/api/songs` 用 `?source=`（默认 netease）；`/api/artist|album|playlist|lyric/:source/:id` 用路径段，并保留 2 段式别名。
  - **搜索分页**：`/api/search` 与 `/api/search/all` 支持 `page`（从 1 起，适配器按 `offset`/页码映射上游）；`/api/search/all` 另支持 `type` **只跑一类**（供前端「续取当前 tab 的下一页」，省掉其余三类上游请求）。前端搜索页滚动到底部（哨兵进入视口）即为当前 tab 续取下一页并追加，直到某页不满（无更多）。
  - **能力可缺**：`SourceAdapter` 的可选成员缺失时，路由回 501，`/api/search/all` 对应类别返回空数组并在 `capabilities` 标记，前端隐藏该分类 tab。**磁带渠道（B 站）**不实现 `searchArtists` / `searchAlbums` 与发现类能力；其 `searchPlaylists` 即**搜磁带**（返回 `source:'bilibili'` 的 `Playlist`）、并实现 `playlistTracks` 供磁带详情页（`/playlist/bilibili/:bvid`）取分P（见 ADR-044）。
  - **登录**：`/api/auth/:source/{status,qr,qr/check,logout}`（一律扫码）；扫码成功（803）时下发**该源**会话 cookie（仅白名单项，剥离 `Domain`/`Secure`/`SameSite`）。
  - **单活动账号**：只在**音乐源之间**成立；`/api/auth/:source/qr/check` 命中 803 且登录的是音乐源时，对**其它音乐源**下发其 `logoutCookieNames` 过期 cookie。**磁带渠道（B 站）与之独立**：登录它不清网易云会话，也不成为活动账号。
  - **凭证**：内容接口 `credentialOf(c, adapter) = cookieOf(c, adapter) ?? defaultCredential(adapter.id)`；缺省凭证来自 `.env` 的 `NETEASE_COOKIE` / `BILIBILI_COOKIE`。身份接口仍只取访客本人 cookie。
  - **会话自愈**：`/api/auth/:source/status` 若访客带了会话 cookie 却判为未登录，则下发清空该源**全部**会话 cookie（各源 `logoutCookieNames` = `sessionCookieNames`，防残留项顶掉缺省凭证）。
  - **缓存**：音频键 `${source}:${id}|${level}`（前端 SW）与 `${source}|${id}|${level}|${cred}`（后端 urlCache）；封面 `imageKey(url)` **不加源**；歌词内存缓存以 `keyOf(track)` 为键。

## 输入 / 输出

- 输入：HTTP 请求（`:source` 段 / `?source=`、cookie、Range）。
- 输出：`ApiResult<T>`（实体均带 `source`）、音频字节流（含 `Content-Range`/`Accept-Ranges`）、登录成功时的 `Set-Cookie`。

## 约束

- 前端永不直连上游域名；音频地址一律 https；封面按源规范化（`canonicalNeteaseImage` / `canonicalBiliImage`，稳定 URL 作缓存键，对齐 ADR-020）。
- `shared/` 不得引入 Node/DOM 专有 API（前后端共用）。
- 后端默认无状态（例外见 ADR-014 / ADR-016）。
- B 站使用**非官方接口**：上游一变即需适配；失败须优雅降级为 403 /「暂不可播放」，不得崩。

## 边界条件

- 非法 `:source`（如 `pl-…`、`spotify`）→ 404；未注册的源 → 404。
- 缺省源语义：2 段式路由（`/stream/:id`、`/api/artist/:id` 等）视为 netease。
- 本地自建歌单仍走 2 段式 `/playlist/pl-xxx`。
- 旧持久化数据缺 `source` → `sourceOf` 回填 `'netease'`，不破坏性回写；`qq`/`migu` 旧数据仍可被 `keyOf` 解析（UI 不可达）。
- VIP / 受限曲：`songUrl` 返回空数组 → 403 `needLogin`；SW 广播 `STREAM_NEED_LOGIN` 带 `source`，前端「登录解锁」引导到该源。
- B 站搜索 / 取音频可能触发风控（返回 `v_voucher`）→ 优雅降级为错误态，不崩。

## 验收标准

- [x] `packages/shared/src/types.test.ts`：`keyOf`/`sourceOf`/`isMusicSource`/`streamUrl` 带源；`isMusicSource('bilibili') === true`。
- [x] `apps/server/src/sources/netease.test.ts`：归一化产出 `source === 'netease'`。
- [x] `apps/server/src/sources/bilibili.test.ts`：标题去 `<em>` / HTML 实体、时长解析、封面主机规范化、按档挑码率、归一化字段。
- [x] `apps/server/src/app.test.ts`：按源凭证隔离；`/stream/:source/:id` 分派 + 2 段别名 + 未知源 404；`/auth/bilibili/status` `loginable:true`；`/stream/bilibili/:id` 403；`/api/search/all?source=bilibili` 标 `songs` 与 `playlists`（磁带）；登出与会话自愈；`audioContentTypeFromUrl` 后缀映射。
- [x] **磁带（ADR-044）**：`apps/server/src/sources/bilibili.test.ts` 的 `buildCassette` / `searchCassettes`（逐条补分P 数、单条失败降级 `trackCount` 留空、并发上限）/ `playlistTracks`；`apps/web/test/components/{Cards,CassetteCard}.test.tsx` 的数量 chip（> 1 才显示）、磁带卡交互与**磁带外壳结构**（卷轴带 `.cassette-shell__deck` / 磁带线 `.cassette-shell__tape` / 双卷轴 `.cassette-reel` ×2）；`app.test.ts` 的 `/api/search/all?type=playlists`（只跑磁带搜索）与 `/api/playlist/bilibili/:id`。
- [x] **搜索累积列表去重（ADR-046）**：`apps/web/test/lib/dedupe.test.ts`（按 `keyOf` 去重、含「模拟上游跨页重复」）；E2E `test/navigation.spec.ts`「磁带 tab 翻页后切到其他 tab：不得有磁带卡混进来」+ 无重复 key 警告。
- [x] **同页变更不跑转场（ADR-045）**：`apps/web/test/lib/viewTransition.test.ts`（`opts.skip` 不转场但仍提交 / 命名标记先于拍快照 / 连点与 skip 均先掐掉在飞转场）；E2E「磁带下钻返回的转场未结束时切 tab：不残留旧快照层」。
- [x] `apps/web/src/lib/mediaCache.test.ts`：`audioKey` 键形；`imageKey` 不含源。
- [x] `apps/web/src/lib/lyricCache.test.ts`：按 `keyOf` 隔离。
- [x] `apps/web/src/store/auth.test.ts`：`activeSource` 只认音乐源（仅登 B 站不成为活动源）。
- [x] **真实环境验证**（已跑）：B 站 `search/all/v2` 返回视频分组；`pagelist → playurl(fnval=16)` 取到 `dash.audio` 多档；带 `Referer` 直链 206 分段可取；网关卡口 `/api/search/all?source=bilibili` 与 `/stream/bilibili/:id` 均 200。
- [x] `pnpm typecheck` 与 `pnpm test` 全绿。
- [ ] **待实测**（需真人 / 联网）：`pnpm test:e2e`；B 站扫码登录全流程（`generate → poll` 成功取 SESSDATA）。

## 完成定义

- 判定已完成：单测与类型检查全绿；手动验证「网易云照常搜索 / 播放」「搜索页 磁带 tab 出 B 站结果且点播能出声」「B 站扫码登录后 磁带音频码率提升」「磁带音频入 SW 缓存」。
