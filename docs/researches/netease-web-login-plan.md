# 网易云登录实现跟进（落地计划）

> 前置阅读：`netease-web-login-protocol.md`

## 目标

用当前网页端协议重写网易云扫码登录的 HTTP 部分，恢复「浏览器扫码登录」与「`pnpm log-in` 终端扫码写入缺省凭证」两条链路；前端契约与登录态判定不变。

## 步骤

1. **确认基线**：`git tag snap/pre-netease-login-*`，跑 `pnpm --filter @pterosaur/server typecheck` 与单测。
2. **适配器改造**（`apps/server/src/sources/netease.ts`）
   - 新增内部小工具 `postNeteaseApi(path, body, headers)`：`fetch` + `application/x-www-form-urlencoded`，UA 用桌面浏览器、`Referer: https://music.163.com/`，返回 `{ body, cookies }`。
   - `qrKey()`：`/api/login/qrcode/unikey`，`type=1`；生成 `chainId` 并按 key 缓存（用有界 Map 或 LRU，5 分钟过期）。
   - `qrCreate()`：改用 `qrcode.toDataURL(qrLoginUrl(key))`（服务端本地生成，不再依赖库）。
   - `qrLoginUrl()`：`https://music.163.com/st/platform/scanlogin?codekey=…&chainId=…&hdw_device=web&hdw_appid=web&hitExp=1`。
   - `qrCheck()`：`/api/login/qrcode/client/login`，`type=1, noCheckToken=true, ydDeviceToken=''`，头 `X-loginMethod: QrCode`、`x-login-chain-id`；映射 `800/801/802/803`，成功取 `set-cookie`。
   - 保留库用于内容接口；`login_qr_*` 不再调用。
3. **服务端路由**：`app.ts` 不改（`qrKey/qrCreate/qrCheck/loginStatus` 契约不变）。核对 `forwardSessionCookies` 对 `MUSIC_U/__csrf/MUSIC_A/NMTID` 的过滤仍然生效。
4. **测试**
   - 新增 `apps/server/test/**` 片段：mock `fetch`，覆盖 `qrKey` 解析、`qrCheck` 803 取 cookie、800 透传、上游报错不误判。
   - 若已有用例 mock 了 `NeteaseCloudMusicApi.login_qr_*`，改为 mock `fetch`。
5. **文档**
   - 更新 `docs/specs/module-default-credential.md`（`login_qr_key` → 现行 `/api` 端点、二维码 URL 变化）。
   - 新增 `docs/DECISIONS.md` ADR：登录协议改为自行实现（脱离库），记录背景、为什么不升级库、后果与重新审视条件。
6. **验收**
   - `pnpm build` + `pnpm --filter @pterosaur/server typecheck` 通过；单测 / E2E 全绿。
   - 手动：`pnpm log-in` 终端扫码 → `.env` 写入 `NETEASE_COOKIE` → 匿名播放 VIP 曲目；网页登录弹窗扫码 → 登录态生效、刷新不掉。
   - 未登录时 `/api/auth/status` 仍 `logged:false`。

## 风险

- 真人扫码验证必须做，否则只能证明「请求格式被上游接受」，不能证明闭环可用。
- 若成功响应里出现风控码（8821/8830/8860），需要按官方分支提示用户（手机端确认 / 二次验证），这一块先留出错误信息透传。
- 库升级可能修好登录，但库维护节奏不可控；本次以自实现收口，升级库只影响内容接口。