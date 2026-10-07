# Pterosaur

仿 Apple Music 的网页音乐播放器：**无需登录，随意畅听**；部署者可用 `pnpm log-in` 配置一份缺省账号，让未登录访客也能播放 VIP 曲目，访客登录自己的账号后则以本人账号为准。

## 这是什么？

- 定位：一个自托管的网页音乐播放器，音源来自网易云音乐，通过自带的 Hono 后端代理解析与串流。
- 解决的核心问题：浏览器无法直连网易云音频（跨域 + `http://` 混合内容限制），也无法免登录播放 VIP 曲目。Pterosaur 用一层同源后端代理把这两件事都解决掉，前端只需关心播放体验。

## 为什么存在？

原项目是 jQuery → Vue 3 的简易播放器，只能靠歌曲 ID 手动添加、技术栈陈旧、功能单薄。本次以 React 19 + Vite 重写，目标是把体验对齐 Apple Music：发现、搜索、歌单、同步歌词、播放队列、收藏与本地歌单，开箱即用。

## 如何安装和运行？

- 前置要求：Node.js ≥ 23.4（云同步用内置 `node:sqlite`，22.5–23.3 需 `--experimental-sqlite`；建议 ≥ 24 LTS），pnpm ≥ 12。
- 安装步骤：

```bash
pnpm install
```

- 开发运行（同时起 Hono 后端与 Vite 前端，Vite 自动把 `/api`、`/stream` 代理到后端）：

```bash
pnpm dev          # 前端 http://localhost:5173，后端 http://localhost:8788
```

- 生产运行（构建前端后，由同一个 Hono 进程同源提供 SPA 与 API）：

```bash
pnpm build
pnpm start        # 默认 http://localhost:8788，可用 PORT 覆盖
```

- （可选）配置缺省账号，让**未登录访客**也能播放 VIP 曲目：

```bash
pnpm log-in       # 打开 http://127.0.0.1:8789 扫码，凭证写入仓库根 .env
```

扫码成功后凭证存入 `.env` 的 `NETEASE_COOKIE`，**需重启服务生效**。建议使用**专用账号**（详见 [ADR-014](./docs/DECISIONS.md)）。

- 测试：

```bash
pnpm test         # Vitest 单元 / 组件测试
pnpm test:e2e     # Playwright 端到端（面向生产形态，会先自动 build）
```

## 当前状态

- 阶段：开发中（功能可用，视觉与交互已对齐 Apple Music 主要范式）。
- 已知限制：
  - 依赖网易云第三方接口；VIP 曲目默认需登录本人账号才能播放。若已用 `pnpm log-in` 配置缺省账号，则未登录访客也可播放（以该账号权限为准）。版权受限曲目可能仍无法播放，界面会给出提示。
  - 生产部署需运行 Node 后端（`pnpm start`），**不是纯静态托管**——音频代理与登录会话都依赖它。
  - 部署到 https 服务器时，前后端同源即可，无需额外处理跨域或混合内容。

## 核心技术

- 前端：React 19、Vite 8、TypeScript、Zustand（状态 + localStorage 持久化）、React Router 7、lucide-react（图标）。
- 后端：Hono 4 + `@hono/node-server`，`NeteaseCloudMusicApi` 解析，`lru-cache` 缓存音频地址。
- 测试：Vitest + Testing Library（单元/组件）、Playwright（E2E）。

更完整的设计说明见 [docs/](./docs)：[PRD](./docs/PRD.md)、[ARCHITECTURE](./docs/ARCHITECTURE.md)、[DECISIONS](./docs/DECISIONS.md)。
