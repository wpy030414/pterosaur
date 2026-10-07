# Spec — 音频流代理与网易云解析后端

对应模块：`server/app.ts`、`server/netease.ts`、`shared/lyric.ts`

## 要构建什么

- 目标：为前端提供一组同源、稳定、类型化的 HTTP 接口，把网易云的搜索、发现、歌单、歌词、登录与音频流能力代理出来；其中音频流必须支持 Range 分段并以 https 提供，VIP 曲目在登录后可播放。

## 行为

- 预期行为：
  - 所有 `/api/*` 返回统一的 `ApiResult<T>` 包裹（`{ ok, data } | { ok:false, error, needLogin? }`）。
  - `GET /stream/:source/:id?level=<档>` 按源分派适配器解析曲目真实音频地址（带 15 分钟 LRU，键含源、**档位**与凭证指纹），把 `http://` 改写为 `https://`，透传客户端 `Range` 头到上游，按 206/200 回流音频字节；无法解析（VIP 未登录/版权受限）时返回 403 且 `needLogin:true`。（2 段式 `/stream/:id` 为缺省源别名，见 ADR-022。）
  - **候选地址与故障转移**：`songUrl` 返回**有序候选**（`string[]`，首个优先，空数组即不可播放）。`/stream` 解析出候选后**逐个尝试**，首个成功即用；全败才回 502 并淘汰该 LRU 项（下次请求重解析）。命中的非首位候选会被**提到队首**回写缓存，避免反复白撞已知坏节点。**B 站**按主机重排候选——官方 upos 主 CDN（`*.bilivideo.com`）优先、`mcdn` P2P 边缘（`*.mcdn.bilivideo.cn`）殿后；后者对机房 IP / 非浏览器客户端不稳，正是「概率性播放出错、再点一次就好」的根因。
  - **音质档位**：`level` 为**统一抽象档**（`standard | higher | exhigh | lossless | hires`，缺省 `exhigh`，见 ADR-031）。网易云直接透传 `song_url_v1`（上游自动降级）；**磁带渠道（B 站）**由抽象档在 `dash.audio[]` 里挑最接近的码率（只取音频轨、不解析视频）。非法 `level` 回退缺省档。
  - 搜索/歌单/歌词接口透传浏览器回传的网易云会话 cookie（若有），从而对登录用户返回可播放的 VIP 地址与个性化内容。
  - 登录：`/api/auth/:source/qr` 生成二维码，`/api/auth/:source/qr/check` 轮询扫码状态，成功（803）时把上游 Set-Cookie 中会话必需的几项下发浏览器（网易云 `MUSIC_U`/`__csrf`/`MUSIC_A`/`NMTID`；B 站 `SESSDATA`/`bili_jct`/`DedeUserID`/`buvid3` 等）；`/api/auth/:source/logout` 下发过期 cookie 清除会话（各源 `logoutCookieNames` = `sessionCookieNames`，防漏清）。**各源一律只支持扫码登录**（不使用帐密）。
  - 归一化：网易云原始结构统一转为 `shared/types.ts` 的 `Track`/`Playlist`，封面/头像改写为 https 并统一产出**大图基准**（网易云 `?param=1200y1200`），由前端 `coverAt` 按使用场景降到小图（300）——见 ADR-031；时长由毫秒转秒，`fee` 映射为 `free|vip|unknown`。

## 输入 / 输出

- 输入：HTTP 请求（查询参数、路径参数、请求头 cookie、Range 头）；登录接口的 JSON body。
- 输出：JSON（`ApiResult`）或音频字节流（`audio/mpeg`，含 `Content-Range`/`Accept-Ranges`）；登录成功时的 `Set-Cookie` 响应头。

## 约束

- 前端永不直连网易云域名；本模块是唯一的上游出口。
- 音频地址一律 https；不得把 `http://` 音频地址直接返给浏览器。
- 后端无业务状态：除音频地址 LRU 缓存外不落盘、不持久化用户凭证。
- `NeteaseCloudMusicApi` 参数为扁平结构（`{keywords, limit}`），返回的 `cookie` 为 Set-Cookie 字符串数组——封装层必须按此处理。
- `shared/` 不得引入 Node/DOM 专有 API（前后端共用）。

## 边界条件

- 曲目 ID 非法或上游无音频：`/stream` 返回 403 + `needLogin`，不抛 500。
- 未知 `:source`（如 `spotify`）或非法源段（如 `pl-…`）：`/stream` 返回 404。
- 上游网络异常/超时：`/api/*` 返回 502 且带可读 error；`/stream` 返回 502。
- 未登录请求 VIP 曲目：解析得到 null → 403 needLogin。
- 搜索关键词为空：400。
- Range 请求：正确透传并回流 206 与 `Content-Range`；无 Range 时回流 200 全量。
- HEAD `/stream/:id`：返回与 GET 一致的头部但不含 body。

## 验收标准

- [x] `GET /api/health` 返回 `{ok:true,data:{status:'ok'}}`。
- [x] `GET /api/search?keywords=...` 返回归一化 `Track[]`，封面为 https。
- [x] `GET /stream/:id` 带 `Range: bytes=0-1023` 返回 206 + `Content-Range` + 真实音频字节（实测 320kbps MP3）。
- [x] VIP/受限曲目未登录时 `/stream` 返回 403 + needLogin。
- [x] `GET /api/lyric/:id` 返回带时间轴与翻译的 `Lyric`。
- [x] 扫码登录链路（qr → check 803 → Set-Cookie → status.logged）在真实网易云下可用。
- [x] 上述契约由 `e2e/player.spec.ts`「后端 API 契约」组覆盖并通过。

## 完成定义

- 如何判定已完成：`pnpm test:e2e` 中后端契约用例全绿；手动 `curl` 验证 `/stream` 的 206 与音频类型；类型检查（`tsc -p tsconfig.server.json`）零错误。
