# 网易云网页登录协议逆向（2026-10）

目标：说清当前 `https://music.163.com` **网页端**登录协议，判断仓库现有实现（NeteaseCloudMusicApi@4.32.0 的 `login_qr_*`）为何失效、能否继续用库、以及要怎么改。

> 证据范围：线上 JS bundle（`ctWebLogin.main.0.3.7.1cebd5b7.js`、`st/platform/scanlogin` 的 `main.8b0ebd48.js` + chunk 64）静态阅读，加上 Node `fetch` 主动探针实测（未真人扫码）。凡「未验证」处已标注。

## 1. 现有实现为什么「登不上」

| 项 | 库（4.32.0）现做法 | 官方网页现做法 |
|---|---|---|
| 取 key 路径 | `POST /eapi/login/qrcode/unikey`（`interface.music.163.com`） | `POST /api/login/qrcode/unikey`（`music.163.com`，明文 JSON） |
| 扫码类型 | `type=3` | `type=1` |
| 二维码内容 | `https://music.163.com/login?codekey=<key>` | `https://music.163.com/st/platform/scanlogin?codekey=<key>&chainId=<chainId>&hdw_device=web&hdw_appid=web&hitExp=1` |
| 轮询 | `POST /eapi/login/qrcode/client/login`（`type=3`） | `POST /api/login/qrcode/client/login`（`type=1, noCheckToken, ydDeviceToken`；header `X-loginMethod: QrCode`、`x-login-chain-id`） |
| 登录态 | `login_status`（weapi `/api/w/nuser/account/get`） | `GET /api/w/nuser/account/get`（`noCheckToken`） |

**根因（推断，证据强）**：扫码用的 App 识别的二维码内容变了。旧链接 `music.163.com/login?codekey=` 在新版网页上已被重定向/废弃（`/login/loadLoginScript` → 302 到 `/404`），App 认不出它就不再回写确认态，于是网页端轮询永远停在 `801`。这个和库 / eapi 加密无关——用官方完全相同的 `/api` 明文请求轮询，结果同样是 `801`（已实测）。

补充实测：`/api/login/qrcode/unikey`、`/api/login/qrcode/client/login`、`/api/user/platform/info`、`/api/w/nuser/account/get` 四个端点用明文 form 请求都能正常返回（不再需要 eapi 加密），`eapi` 版本反而在 `interface.music.163.com` 上表现为页面 HTML（`/eapi/...` 打到官网域名会返回 0 字节）。

## 2. 现行协议（网页 / 终端通用，手机 App 扫码）

### 2.1 取 key

```
POST https://music.163.com/api/login/qrcode/unikey
Content-Type: application/x-www-form-urlencoded

type=1
```

响应：`{ "code": 200, "unikey": "<uuid>" }`（另有 `Set-Cookie: NMTID=...`）。

### 2.2 二维码内容

```
https://music.163.com/st/platform/scanlogin?codekey=<unikey>&chainId=<chainId>&hdw_device=web&hdw_appid=web&hitExp=1
```

- `chainId`：`v1_<sDeviceId>_web_login_<Date.now()>`，`sDeviceId` 取 cookie，没有就 `unknown-<随机数>`。
- 这个页面是「扫码落地页」：手机 App 扫到后会打开它，用户在手机上确认登录。终端渲染二维码时应直接编码**这一整条 URL**。
- 未验证：`chainId` 是否对扫码确认有硬性校验。库在网页 modal 里会把它同时作为轮询请求头 `x-login-chain-id` 发回；保守做法是**同一条 chainId 用于 URL 与轮询头**。

### 2.3 轮询

```
POST https://music.163.com/api/login/qrcode/client/login
X-loginMethod: QrCode
Content-Type: application/x-www-form-urlencoded

key=<unikey>&type=1&noCheckToken=true&ydDeviceToken=<指纹 token，可为空>
```

- `ydDeviceToken` 来自浏览器侧 `createNEFingerprint`（`NEFingerprint` + appId `9d0ef7e0905d422cba1ecf7e73d77e67`）。取不到时官方代码 `catch` 成空串继续，所以 Node 侧传空即可（当前 801 阶段已验证不报错；成功阶段的接受度**未验证**）。
- 状态码：`801` 等待扫码、`802` 已扫码待确认、`803` 成功（与旧契约一致）；`800` 过期。
- 成功时 `Set-Cookie` 里应有 `MUSIC_U` / `__csrf` 等，和旧实现的下发逻辑兼容。

### 2.4 「已登录设备扫码验证」的另一套（与本次无关）

网页二次验证用的是 `/api/login/origin-device/scan-apply/{start,check,cancel}`，二维码里是 `pollingToken`，不是 unikey——不要和上面的 unikey 流程混用。

## 3. 对仓库的改造建议

结论：**别继续埋在库里**。库的 `login_qr_key / login_qr_check` 是 eapi + type=3 + 旧 URL 三连，改参数也绕不开它把 `type` 写死成 3、把 QR URL 写死。改为在 `apps/server/src/sources/netease.ts` 里自己发这几条 `/api` 明文请求（`fetch` 即可），只保留库给内容接口（搜索 / 歌曲 / 歌词 / 音频 URL）用。

具体改动点：

1. `netease.ts`
   - `qrKey()`：`POST /api/login/qrcode/unikey` `type=1`，返回 `unikey`；同时生成并缓存 `chainId`（按 key 存），后续轮询带着。
   - `qrLoginUrl(key)`：返回上面的 `st/platform/scanlogin?...` 完整 URL（终端渲染用）。
   - `qrCreate(key)`：本地 `qrcode` 生成 data URI（已有依赖），不再走库的 `login_qr_create`（它拼的还是旧 `/login?codekey=`）。
   - `qrCheck(key)`：`POST /api/login/qrcode/client/login`，带 `type=1&noCheckToken=true&ydDeviceToken=` 与 `X-loginMethod: QrCode`、`x-login-chain-id: <chainId>`，返回 `{ code, cookies, message }`；`cookies` 取自响应 `set-cookie`。
   - `loginStatus()`：可继续用库，或改直连 `GET /api/w/nuser/account/get`（已实测明文可用，能直接消除库的 eapi 变量）。
2. 路由 / 前端：契约不变（`/api/auth/:source/qr`、`/qr/check`、code 语义不变），**前端零改动**；`LoginModal.tsx` 无需动。
3. 测试：`apps/server/test/**` 里若有 mock 库函数的用例，需要改成 mock `fetch`；补一条「轮询 803 时下发 MUSIC_U」的用例。
4. 文档：`docs/specs/module-default-credential.md` 中「key 由 `login_qr_key` 取得 / 内容为 `/login?codekey=`」两句需更新；ADR 新增一篇说明为什么要脱离库的登录实现。

## 4. 仍然未验证

- 真人扫码后，App 是否会把 `802/803` 回写到 unikey 会话（需要一次真实扫码）。
- `ydDeviceToken` 为空时，成功响应是否会带 `8821/8830/8860` 之类风控码（官方代码里有对应处理分支）。
- `chainId` 在轮询头里缺省时是否仍能成功（保守起见先带上）。
- 手机 App 对 `st/platform/scanlogin` 页面是否有版本要求。