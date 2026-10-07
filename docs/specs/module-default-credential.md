# Spec — 服务端缺省凭证（`pnpm log-in`）

对应模块：`server/env.ts`、`server/cli/login.ts`、`server/app.ts`、`server/netease.ts`、`.env.example`、根 `package.json`

## 要构建什么

- 目标：给服务端一份**缺省网易云凭证**，让**未登录访客**也能解析并播放 VIP 资源；凭证由一条 `pnpm log-in` 命令扫码获得并写入仓库根 `.env`，不经过源码、可随时轮换。
- 交互形态：二维码**直接打印在终端**，不弹浏览器、不起本地 HTTP 服务。

## 行为

- 预期行为：
  - `pnpm log-in` 在终端打印一个二维码（`qrcode` 的 terminal 渲染，半块字符），内容为 `https://music.163.com/login?codekey=<key>`；`key` 由网易云 `login_qr_key` 取得，二维码由本地渲染（`login_qr_create` 不请求上游）。
  - 扫码状态由本进程**统一轮询**（每 1.5s，调 `login_qr_check`）；终端字样随「等待扫码 → 已扫码待确认 → 成功」变化，并**去重打印**避免刷屏。
  - 二维码过期（800）时**自动换一张新码**并重置有效期计时；整体超时 5 分钟退出 1，`Ctrl-C` 退出 130。
  - 扫码成功（803）时，把会话 cookie 写入仓库根 `.env` 的 `NETEASE_COOKIE`（并记 `NETEASE_COOKIE_UPDATED_AT`），保留文件其余行与注释；随后退出 0。
  - 服务端启动时先 `loadEnv()` 读取仓库根 `.env`（存在才读，缺失不报错）。
  - 内容接口（搜索 / 搜索聚合 / 推荐 / 歌单 / 艺人 / 专辑 / 歌曲详情 / 歌词 / `/stream/:source/:id`）取 `credentialOf(c, adapter) = 访客 cookie ?? defaultCredential(adapter.id)`。缺省凭证按源来自 `.env`：网易云 `NETEASE_COOKIE`、B 站 `BILIBILI_COOKIE`（见 ADR-022 / ADR-033）。网易云可用 `pnpm log-in` 扫码写入；B 站可在应用内「登录」扫码后手工粘贴，或直接留空（匿名亦可取 磁带音频，仅码率较低）。
  - 身份接口（`/api/auth/status`、`/api/auth/qr*`、`/api/auth/login`、`/api/user/playlists`）仍只取访客本人 cookie——匿名访客永远显示「未登录」。
  - 音频地址缓存键含**凭证指纹**（cookie 的 SHA-1 前 12 位；无凭证为 `anon`），不同账号不串用解析结果。

## 输入 / 输出

- 输入：`pnpm log-in`（无参数）；进程信号 `SIGINT`；服务端的 `.env` 文件。
- 输出：终端上渲染的二维码与状态字样、成功/失败提示；写入 `.env` 的 `NETEASE_COOKIE` / `NETEASE_COOKIE_UPDATED_AT`。

## 约束

- 缺省凭证**只用于内容解析**，绝不参与身份判断——这是与「会话边界」的明确分界（见 ADR-014）。
- 不弹浏览器、不起本地监听端口；二维码只在终端呈现。
- 前端零改动，同源铁律不变；凭证不进源码、不进前端产物（`.env` 已被 `.gitignore` 忽略，另提供 `.env.example`）。
- 复用 `server/netease.ts` 的 `qrKey/qrLoginUrl/qrCheck/cookieHeaderFromSetCookies/loginStatus`；二维码渲染用直接依赖 `qrcode`。
- `.env` 变更需重启服务生效。

## 边界条件

- 无 `.env`：`loadEnv` 静默跳过，行为与改动前一致。
- `.env` 无 `NETEASE_COOKIE`（空串）：视作无缺省凭证。
- 上游轮询抛错（网络抖动）：**保持当前状态**，等下一次轮询，不误报过期。
- 二维码过期（800）：打印提示并自动换新码，不退出。
- 803 但未取到会话 cookie：不写 `.env`，提示后继续重试。
- 访客已登录：`credentialOf` 优先访客 cookie，缺省凭证不生效。

## 验收标准

- [x] `pnpm --filter @pterosaur/server log-in` 在终端打印可扫描的二维码，并显示「等待扫码…」。
- [x] 扫码后终端字样变为「已扫码，请在手机上确认…」（轮询在服务端进行，无需外部页面）。
- [x] 扫码成功后将 `NETEASE_COOKIE` 写入仓库根 `.env`（原有键/注释保留；`env.test.ts` 覆盖替换 / 追加 / 保留 / 往返解析）。
- [x] 未登录访客的内容请求透传缺省凭证，而 `/api/auth/status` 仍为 `logged:false`（`app.test.ts` 覆盖）。
- [x] 访客本人 cookie 优先于缺省凭证（`app.test.ts` 覆盖）。
- [x] `pnpm --filter @pterosaur/server typecheck` 零错误。

## 完成定义

- 如何判定已完成：单元测试全绿且类型检查零错误；手动 `pnpm log-in` 走通「终端扫码 → 写盘 → 重启 → 匿名播放 VIP」全链路；缺省凭证未配置时行为与改动前一致。
