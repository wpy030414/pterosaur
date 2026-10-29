# Pterosaur

仿 Apple Music 的网页音乐播放器。音源来自网易云音乐 + B 站 MV 音频；部署者可用 `pnpm log-in` 配置缺省账号，让未登录访客播放 VIP 曲目；登录后自动多设备云同步资料库。

## 这是什么？

- 定位：一个自托管的网页音乐播放器，音源来自网易云音乐与 B 站 MV（只播音频），通过 Hono 后端代理解析、串流与扫码登录。
- 解决的核心问题：浏览器无法直连网易云/B 站音频（跨域 + `http://` 混合内容），也无法免登录播放 VIP 曲目。Pterosaur 用同源后端代理解决，前端只关心播放体验。

## 为什么存在？

原项目是 jQuery → Vue 3 的简易播放器，只能靠歌曲 ID 手动添加、技术栈陈旧、功能单薄。本次以 React 19 + Vite 重写，目标是把体验对齐 Apple Music：发现、搜索、歌单、同步歌词、播放队列、收藏与本地歌单，开箱即用。

## 如何安装和运行？

- 前置要求：Node.js ≥ 24（见 `.nvmrc`；云同步用内置 `node:sqlite`），包管理器由 [Vite+](https://viteplus.dev)（`vp`）按 lockfile 自动代理。
- 安装步骤（先装 vp：`curl -fsSL https://vite.plus | bash`，之后 `vp install` 会按 lockfile 代理 pnpm）：

```bash
vp install
```

- 开发运行（同时起 Hono 后端与 Vite 前端，Vite 自动把 `/api`、`/stream` 代理到后端）：

```bash
pnpm dev          # 前端 http://localhost:5173，后端 http://localhost:8788
```

- 生产运行（构建前端后，由同一个 Hono 进程同源提供 SPA 与 API）：

```bash
pnpm build        # vp pack 构建 server，vp build 构建 web（含 PWA/SW）
pnpm start        # 默认 http://localhost:8788，可用 PORT 覆盖
```

- （可选）配置缺省账号，让**未登录访客**也能播放 VIP 曲目：

```bash
pnpm log-in       # 打开 http://127.0.0.1:8789 扫码，凭证写入仓库根 .env
```

扫码成功后凭证存入 `.env` 的 `NETEASE_COOKIE`，**需重启服务生效**。建议使用**专用账号**（详见 [ADR-014](./docs/DECISIONS.md)）。

- 测试：

```bash
pnpm test         # 单元 / 组件测试（vp test → Vitest）
pnpm check        # 格式 + 静态检查 + 类型（vp check → oxfmt / oxlint）
pnpm test:e2e     # Playwright 端到端（面向生产形态，会先自动 build）
```

## 当前状态

- 阶段：开发中（功能可用，视觉与交互已对齐 Apple Music 主要范式）。
- 已知限制：
  - 依赖网易云第三方接口；VIP 曲目默认需登录本人账号才能播放。若已用 `pnpm log-in` 配置缺省账号，则未登录访客也可播放（以该账号权限为准）。版权受限曲目可能仍无法播放，界面会给出提示。
  - 生产部署需运行 Node 后端（`pnpm start`），**不是纯静态托管**——音频代理与登录会话都依赖它。
  - 部署到 https 服务器时，前后端同源即可，无需额外处理跨域或混合内容。

## 核心技术

- 前端：React 19、Vite 8、TypeScript、Zustand（library 走 IndexedDB 持久化）、React Router 7、lucide-react（图标）、vite-plugin-pwa（PWA + Service Worker 媒体缓存）。
- 后端：Hono 4 + `@hono/node-server`，`NeteaseCloudMusicApi`（网易云）、自研 B 站适配器（`dash.audio` + 字幕歌词）、`lru-cache`（音频地址缓存）、`node:sqlite`（云同步存储）。
- 测试：Vitest + Testing Library（单元/组件）、Playwright（E2E）。

更完整的设计说明见 [docs/](./docs)：[PRD](./docs/PRD.md)、[ARCHITECTURE](./docs/ARCHITECTURE.md)、[DECISIONS](./docs/DECISIONS.md)。
