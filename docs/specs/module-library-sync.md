# Spec — library 云同步（云端权威 + SSE）

对应模块：`server/syncDb.ts`、`server/syncStore.ts`、`server/syncEvents.ts`、`server/app.ts`、`server/env.ts`、`shared/types.ts`、`web/store/sync.ts`、`web/lib/sync.ts`、`web/hooks/useLibrarySync.ts`、`web/store/auth.ts`、`web/api/client.ts`、`web/components/Topbar.tsx`、`web/App.tsx`（见 ADR-038，修订 ADR-016）

## 要构建什么

- 目标：登录后把 library（收藏 / 最近 / 自建歌单 / 收藏的网易云歌单 · 艺人 · 专辑）在**多设备间近实时同步**。
- 交互形态：头像下拉菜单里一个「云同步」开关（位于「退出登录」上方）；**登录后默认开启**，开启即同步，随后本地任意改动自动防抖推送；其它设备的改动经 SSE 近实时送达。

## 行为

- 预期行为：
  - **登录即默认开启**：`finishQrLogin` 成功后记录 `enabled` 与当前**活动账号**（`source` + `accountId`）。可手动关闭 / 再次开启。
  - 激活条件：开关开启 **且** 已登录 **且** 活动账号与开启时绑定的一致；换账号自动失活。
  - **进入同步启用态（登录瞬间 / 打开开关瞬间 / 打开页面瞬间）**统一执行 `syncOnEntry()`：拉取云端——**有数据即以云端覆盖本地**（丢弃本地），**云端为空则以本地为准并上传**。
  - 激活期间订阅 `useLibrary` 变更，约 1.5s 防抖推送；应用云端数据时抑制回声（不回推）。
  - 激活期间打开 `GET /api/sync/events` 的 SSE：收到 `{ rev }` 且比本机已知版本新时重拉并应用；连接断开后每 **5s** 重连、**永不停止**。
  - 关闭开关仅停止同步，**不删**云端副本。
  - 服务端：`GET /api/sync/library` 返回本人 `{ payload: SyncEnvelope | null }`；`PUT` 覆盖写入（**服务端指派 `rev` / `updatedAt`**）并广播 `{ rev }`；`GET /api/sync/events` 为该账号的 SSE 流；均以**访客本人的活动账号**判定身份（未登录 401）。
  - 存储：嵌入式 SQLite，库 `<DATA_DIR|仓库根/.data>/sync.db`，表 `sync_docs(key, state, rev, updated_at)`（WAL）；首次打开把旧 `sync/*.json` 迁入。

## 输入 / 输出

- 输入：登录成功；开关点击；本地 library 变更事件；`GET/PUT /api/sync/library`（携带登录 cookie；`PUT` body 为 `{ state }`）；`GET /api/sync/events`（SSE）。
- 输出：本地 library 被云端覆盖或云端被本地覆盖；服务端 `SyncEnvelope | null`；SSE `event: rev` 消息与心跳 `ping`。

## 约束

- **身份只取访客本人的活动账号**（`requireIdentity`），绝不回退缺省凭证（否则会把匿名访客当成运营者账号）。
- 冲突策略固定为**云端权威**（进入即云端覆盖本地；云端为空则本地为准并上传）；`rev` / `updatedAt` 由**服务端**指派，客户端不产生时间戳。
- 同步范围仅 `library`，不含 `player` 播放态。
- SSE 事件**只携带 `rev`**（不推整份 state）；广播仅限同账号的其它连接；连接断开须退订。
- 服务端存储零新依赖（`node:sqlite` 内置）；`.data/` 不进仓库；账号键净化以杜绝路径穿越；载荷体积上限 5MB。
- 复用 `server/netease.ts` 的 `loginStatus`、`server/env.ts` 的 `ROOT_DIR`、`web/store/library.ts` 的 store。
- 部署：SSE 需 nginx `proxy_buffering off` + 足够长的 `proxy_read_timeout`（响应另带 `X-Accel-Buffering: no`）；后端为单实例，水平扩展不成立。

## 边界条件

- 未登录 / 未开启：引擎不启动，无任何网络请求、不打开 SSE。
- 云端为空（首次开启 / 新账号）：以本地为准并上传。
- **本地未上传的改动会在进入同步态时被云端覆盖而丢弃**（云端为空时例外）——「每次操作都上云」模型的前提，已与用户确认。
- 换账号：绑定的活动账号与当前不符 → 失活，不为新账号悄然开启。
- 多设备并发：后推送者在云端胜出，其它设备经 SSE 重拉收敛。
- 存储损坏 / 读失败：读返回 `null`（视为云端无数据）；写失败回 400，不影响其它功能。
- 旧数据迁移：首次打开新库时把 `sync/*.json` 以 `rev = 1` 迁入（`INSERT OR IGNORE`，不覆盖已有行）。

## 验收标准

- [x] `syncStore.test.ts` 覆盖读回、用户隔离、缺失返回 null、`rev` 递增、形状 / 体积 / `userId` 净化校验、旧 JSON 迁移。
- [x] `isLibraryState` 只校验基础形状（宽容解析）：旧载荷缺 `savedArtists`、或含未知新字段，均判合法，避免被判非法 → 空库覆盖云端。
- [x] `web/lib/sync.test.ts` 覆盖 `syncOnEntry` 两分支（云端有数据 → 覆盖本地；云端为空 → 上传本地）、`applyPayload` 归一化、SSE 客户端（按 `rev` 重拉、忽略回声、断开 5s 重连）。
- [x] `syncRoutes.test.ts` 覆盖注册表订阅 / 广播 / 退订、`PUT` 指派 `rev` 且广播、未登录 401、非法载荷 400。
- [x] `pnpm --filter @pterosaur/server typecheck` 与 `apps/web` typecheck 零错误。
- [ ] 手动在多浏览器（同账号）验证：登录即同步、一端改动另一端正近实时更新、断开后自动重连；换账号失活。

## 完成定义

- 如何判定已完成：单元测试全绿且类型检查零错误；手动在两浏览器（同账号）验证登录即同步、双向近实时同步、关闭后停止、换账号失活。云同步 E2E 依赖真实扫码登录，无法自动化，以单测 + 手动验证覆盖。
