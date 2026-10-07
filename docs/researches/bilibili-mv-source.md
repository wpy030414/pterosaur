# Research — B 站（哔哩哔哩）磁带音频接入

> 状态：**已落地**（磁带渠道，只放音频）。相关：`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`（ADR-022 / ADR-031 / ADR-033 / **ADR-044**）、`apps/server/src/sources/bilibili.ts`。

## 结论

- B 站视频是 **DASH 音视频分轨**：取流接口同时给出 `dash.video[]` 与 `dash.audio[]`。本项目**只取 `dash.audio`**、不解析视频——即「磁带只放音频」。
- 音频直链是 `*.bilivideo.*` / `*.mcdn.bilivideo.cn` 上的**明文 m4s**（fMP4/AAC，带 `Accept-Ranges: bytes`），**无 DRM**，可沿用既有 `/stream/:source/:id` 明文代理。
- **搜索**首选 `x/web-interface/search/all/v2`（实测未被风控）；`x/web-interface/wbi/search/type` 会回 `v_voucher` 人机验证，弃用。
- **取字节必须带 `Referer: https://www.bilibili.com`**，否则 403。

## 端点（实测）

| 用途       | 端点                                                   | 说明                                                           |
| ---------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| 匿名指纹   | `x/frontend/finger/spi`                                | 返回 `b_3`（buvid3），进程内缓存 6h                            |
| 搜索       | `x/web-interface/search/all/v2?keyword=&page=1`        | `data.result[]` 按 `result_type` 分组，取 `video` 组；20 条/页 |
| 取 cid     | `x/player/pagelist?bvid=`                              | `data[0].cid`                                                  |
| 取流       | `x/player/playurl?bvid=&cid=&fnval=16&fnver=0&fourk=1` | `data.dash.audio[]`（`baseUrl` / `bandwidth` / `id`）          |
| 登录二维码 | `passport-login/web/qrcode/generate`                   | 返回 `url` + `qrcode_key`                                      |
| 轮询扫码   | `passport-login/web/qrcode/poll?qrcode_key=`           | `data.code`：0 成功 / 86090 待确认 / 86038 失效 / 86101 未扫   |
| 登录态     | `x/web-interface/nav`                                  | `data.isLogin` / `uname` / `face` / `mid` / `vipStatus`        |

## 关键实现约定

- **二维码「URL 即 key」**：`generate` 的 `url` 与 `qrcode_key` 来自同一响应，而 `poll` 只认 `qrcode_key`。故适配器把 **URL 当作 key**：`qrCreate` 直接渲染它、`qrCheck` 从 URL 解析出 `qrcode_key` 再轮询——**全程无状态**，无需服务端缓存 key→url。
- **档位挑码率**：`LEVEL_TARGET_BPS` 把抽象档映射到目标码率，在 `dash.audio[]` 里挑最接近的一条（并列取更高码率）。匿名实测三档 43.9k / 102.9k / 203.8k bps。
- **封面规范化**：`i0`–`iN.hdslb.com` 互为镜像 → `canonicalBiliImage` 统一到 `i0.hdslb.com`（对齐 ADR-020，免缓存碎片）。
- **响应 Content-Type**：直链为 `application/octet-stream`，由 `app.ts` 的 `audioContentTypeFromUrl` 按 `.m4s` 后缀回写为 `audio/mp4`，SW 方能按 `audio/*` 入缓存（见 ADR-033）。
- **会话 cookie 名单**：`SESSDATA` / `bili_jct` / `DedeUserID` / `DedeUserID__ckMd5` / `buvid3` / `bili_ticket`；登出清理 = 会话名单（防残留项顶掉缺省凭证）。
- **分P 一对多**：`x/web-interface/view?bvid=` **一次请求**即含标题 / 封面 / UP 主与 `pages[]`（每页 `cid`/`page`/`part`/`duration`），故 `parts()` 无需再请求 `pagelist`；展开项 `id` 为 `<bvid>:<cid>`。
- **封面防盗链**：`i0–iN.hdslb.com` 对**异域 `Referer` 返回 403**（无 Referer 才 200）——故 `<img>` 与 SW 图片回源均带 `referrerPolicy: 'no-referrer'`。
- **匿名解析重试**：`bGet` **只要任何一次请求失败就重试**（网络错误 / 非 2xx / `code !== 0`，**与错误码无关**），固定 333ms 间隔、共 5 次。

## 磁带（类歌单化，ADR-044）

> 渠道其余不变（只放音频、字幕作歌词），仅把搜索结果的**呈现与身份**从「平铺 Track」改为「类歌单的磁带」。

- **磁带 = 一个 `Playlist`（`source:'bilibili'`, `id=bvid`）**：`trackCount`=分P 数、`creator`=UP 主。适配器以此实现 **`searchPlaylists`**（= 领域命名的 `searchCassettes`）与 **`playlistTracks`**，从而白拿歌单的收藏 / 侧边栏 / 云同步 / 详情页（`/playlist/bilibili/:bvid`）。`buildCassette` / `searchCassettes` / `playlistTracks` 见 `apps/server/src/sources/bilibili.ts`。
- **分P 数需逐条补查**：`search/all/v2` 的 video 组**不含**分P 数（实测字段里没有 `videos`）——只能对每条结果再查一次 `x/web-interface/view?bvid=` 取 `pages.length`。故 `searchCassettes` 对整页结果**并发受限（上限 4）**地补查，单条 **5s 超时**；失败 / 超时**降级为 `trackCount` 留空**（不写 0，否则卡片会置灰「播放」）。整批结果再由 `/api/search/all` 缓存 2h（ADR-042）摊薄成本。
- **`view` 进程内 memo**（LRU `max:200`、TTL 2h、键 `sha1(cookie)|bvid`）：搜索补查与「点进详情 / 展开分P」共用，同一 bvid 同凭证至多打一次上游。

## 风险

- 全部为**非官方接口**，上游改版即需适配；搜索端点存在**风控**（换 IP 可能触发人机验证 → 返回 `v_voucher`）。
- 匿名即可取音频（上限约 204kbps）；更高码率 / 更稳定需 SESSDATA（扫码登录或 `BILIBILI_COOKIE`）。
- 与既有音源（网易云）同级：抓未公开接口 + 自托管个人使用，风险自担。
