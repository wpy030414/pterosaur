# Spec — 自定义应用背景与取色主题

对应模块：`web/components/AppBackground.tsx`、`web/components/SettingsDialog.tsx`、`web/components/NowPlaying.tsx`、`web/store/settings.ts`、`web/lib/background.ts`、`web/lib/accent.ts`、`web/hooks/useBackgroundUrl.ts`、`web/hooks/useAccentFromBackground.ts`、`web/lib/idb.ts`、`web/lib/reset.ts`（见 ADR-039）

## 要构建什么

- 目标：允许用户上传图片 / 动图 / 视频作为**应用背景**（涵盖顶栏、侧边栏、主内容区，**不含底部播放条**），并自动从其取色替换默认红主题色。
- 交互形态：设置弹窗「音质」下方新增「背景」项——上传 / 更换、清除。

## 行为

- 上传后：媒体本体写入 IndexedDB 的专用 `background` store；`settings` 存轻量元数据 `{ kind, mime, accent }`；立即渲染背景层。
- 背景层位于 `.app-shell` 内、内容之下（`z-index: -1` + `isolation: isolate`；底边留出 `--playerbar-height` 以排除底栏）。有背景时在 `<html>` 打 `data-has-bg`，CSS 据此把三大区域调得更透明。
- 取色：图 / 视频首帧 → 24×24 离屏 canvas 取平均色 → 派生 `--accent / --accent-hover / --accent-press / --accent-soft`（JS 覆写，见 `useAccentFromBackground`）。清除背景即回落默认红。
- 沉浸播放页：设了背景即隐藏封面、背景换为（高斯模糊的）自定义图；未设置则维持「封面 + 封面模糊」现状。
- 持久化：仅**本地**。刷新后自动恢复（元数据在 localStorage、本体在 IDB）。

## 输入 / 输出

- 输入：设置弹窗的文件选择（`<input type="file" accept="image/*,video/*">`）、清除按钮。
- 输出：`.app-bg` 层（`<img>` / `<video>`）、被覆写的 `--accent*`、`data-has-bg` 标记、IDB `background` 记录、localStorage `pterosaur-settings`。

## 约束

- 媒体本体**必须**落 IDB（localStorage ~5MB 且只存字符串，放不下视频 / 大图）；独立 store 且**不参与媒体池 LRU**。
- **不被登录 / 退出的清缓存波及**（`lib/clearCaches.ts` 不触碰 `background` store）；`resetAll` 会清它。
- `saveBackground` 写入后**读回校验**，失败即抛出（避免留下「设置了背景却看不到图」的幽灵状态）。

## 边界条件

- 未设置背景：不渲染背景层、不设 `data-has-bg`、不覆写 `--accent`。
- IDB 不可用 / `background` store 缺失：写入失败 → 报错并**不落配置**（不进入幽灵状态）。
- 取色失败（无 canvas / 灰度图）：`accent` 回落默认红，背景仍正常显示。
- 视频 / 动图：`<video autoplay loop muted playsinline>` 回放；取色取首帧。

## 验收标准

- [x] `settings.test.ts` 覆盖 `background` 默认空、设置 / 清除。
- [x] `accent.test.ts` 覆盖 `deriveAccent` 产出四档、非法 hex 回落、同色相。
- [x] `reset.test.ts` 覆盖重置清空 `background` store。
- [x] E2E（`settings.spec.ts`）：上传背景 → 背景层出现且 `--accent` 被覆写；刷新后仍在；清除后消失、`--accent` 回落。
- [x] 沉浸页：设背景时隐藏封面（`nowplaying--nocover`）。
