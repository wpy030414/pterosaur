# Spec — 翻录（分发双通道：数字打包 / 本机直刻 CD）

对应模块：`shared/rip.ts`、`web/lib/rip.ts`、`web/lib/downloadPlaylist.ts`、`web/lib/burn.ts`、`web/store/rip.ts`、`web/store/ui.ts`（ripDialog）、`web/components/RipDialog.tsx`、`web/components/RipButton.tsx`、`server/rip.ts`、`server/imapi.ts`、`server/imapiFake.ts`、`server/ffmpeg.ts`、`server/audioFetch.ts`

相关决策：ADR-047（分发双通道与 meta.json）、ADR-048（后端直刻）、ADR-014（缺省凭证，实体链路取流凭证）、ADR-031（音质档位）

## 要构建什么

- 目标：详情页（歌单 / 专辑 / 我喜欢的音乐）的「翻录」不再只有一种产物——用户按**后续分发方式**选择：
  - 「后续将数字分发」→ 浏览器 JSZip 打包下载：音频 + 封面（如有）+ 根级 `meta.json`；
  - 「后续将实体分发」→ **后端直刻本机光驱**（仅同机访问开放）：数据 CD（音频 + 封面 + meta.json 上盘）或标准音频 CD（CD-DA，44.1kHz/16bit PCM 转码）；刻录成功后浏览器另存 `meta.json`。
- 两种方式的 `meta.json` 同 schema（`pterosaur-rip@1`）、同构建器。

## 行为

- 预期行为：
  - 点「翻录」→ `RipDialog`：分发方式分段选择（默认数字）；选「实体」时展开光盘类型、刻录能力状态行（刻录机 / 介质 / 重新检测）、禁用原因与不可逆警告；实体仅本机（`isLoopbackHost(location.hostname)`）且能力可用（有刻录机 + 空白 CD-R/CD-RW；音频 CD 另需 ffmpeg 与时长 ≤ 79 分钟含 2s/轨 gap）时可开始。
  - 数字链路：逐首经 `/stream/:source/:id?level=` 取流 → `zip.file('NN - 标题.ext', blob)`（ext 取自响应 Content-Type）→ 全部完成后构建 `meta.json`（`fileOf` 回填实际文件名、失败曲目入 `skipped`）→ `saveAs('名称.zip')`。
  - 实体链路：前端**先建** `EventSource('/api/rip/events')` 再 `POST /api/rip/burn`（202）；服务端单任务状态机——探测刻录机/介质（先于取流，无盘立即失败）→ 逐轨经 audioFetch 流式落盘（单轨失败 fail-fast）→（音频 CD）ffmpeg 逐轨转码 → 数据 CD 补封面与 `meta.json` → `burnDisc` 写盘 → 广播 `done`；前端按事件把 `phase/current/total/percent` 写全局 `useRip`，`done` 后 `saveAs('meta.json')`。
  - 进度渲染：`RipButton` 就地成环——fetch / convert 阶段为确定进度（n/总数），burn 阶段为**不确定进度**（旋转弧 + 「刻录」）。
  - 失败：统一在 `runRip` 弹出 `confirmDialog`（标题按分发方式：翻录失败 / 刻录失败；文案来自服务端错误码映射）。
- 非预期行为（守卫）：已有翻录进行中时忽略重复发起；后端已有任务时 409；`skipped` 之外**不静默吞错**。

## 输入 / 输出

- 输入（前端）：合集信息（kind / name / source / sourceId / creator / coverUrl）、曲目列表（`Track[]`）、`settings.level`、用户的分发方式与光盘类型选择、`GET /api/rip/capabilities`（对话框打开时拉取，非本机不发请求）。
- 输入（后端 `POST /api/rip/burn`）：`{ meta, tracks, discType, level }`——校验：曲目 ≤ 500、同源、字段限长、合法 discType/level/kind、非空名、音频 CD 容量预检。
- 输出：数字 = `.zip`（音频 + 可选 `cover.<ext>` + `meta.json`）；实体 = 光盘（数据 CD 含 `meta.json` + 封面）＋ 浏览器 `meta.json` 下载；进度经 SSE（`state` 快照帧 / `progress` / `done` / `error`）。

## 约束

- `meta.json` 与命名工具（`safeRipName` / `ripFileName` / `extFromMime` / `extFromImageMime`）**只在** `shared/rip.ts` 一份实现；两端产物同构。
- 回环双门控 fail-closed：前端 hostname + 后端 `getConnInfo` 对端地址；`/api/rip/*` 非回环一律 403。
- 直刻仅 Windows（IMAPI2）；PS 模板 ASCII-only、配置走 UTF-8 JSON、stdout JSON lines、错误码→中文映射在 Node 侧；写入前复检介质，只接受 CD-R/CD-RW。
- ffmpeg 解析顺序：`PTEROSAUR_FFMPEG_PATH` → `@ffmpeg-installer/ffmpeg`（静态包，无可执行时仅音频 CD 禁用）。
- staging：`os.tmpdir()/pterosaur-burn-*`，成败均清，启动清扫 24h 残留；文件名全走 `safeRipName`（防路径穿越）；封面 URL 白名单（https 的 `*.music.126.net` / `*.hdslb.com`，防 SSRF）。
- 刻录阶段 `percent` 恒为 `null`（IMAPI 不可得，见 ADR-048）；前端快照帧按请求发起时刻过滤陈旧终态。
- 模拟缝 `PTEROSAUR_RIP_FAKE_BURN=1`：探测 / 取流（合成合法 WAV）/ 刻录全模拟，capabilities 报 `simulated:true`。

## 边界条件

- 磁带（B 站）分P 翻录：与歌单同链路；实体链路要求同源（单盘磁带天然同源），混合收藏（多源）在对话框即禁用实体并给原因。
- 专辑翻录封面取 `COVER_RIP=3000`（母带上限）；封面获取失败不阻断（zip / 盘上无 cover，meta.cover 缺省）。
- 音频 CD：`meta.tracks[].file` 与 `meta.cover` 缺省（盘上无文件系统）；超时长在对话框与后端二次拒绝。
- 数据 CD：落盘累计超介质估算容量在写入前中止；介质非空白 / 无介质 / 无刻录机分别在对话框禁用、后端 400/202 后立即失败。
- 非 Windows：capabilities `supported:false`，POST 501（前端据此禁用实体）。
- 刻录期间关闭页面：任务在服务端继续；重开后经 `status` / SSE 快照帧可查终态（前端 store 不持久化）。
- 60 秒内连续发起两次刻录：陈旧终态回放被请求时刻过滤，不会串盘。

## 验收标准

- [x] `buildRipMeta` / `audioCdFits(Total)` / `isLoopbackHost` / `safeRipName` / `ripFileName` / `extFrom*` —— `packages/shared/test/rip.test.ts`。
- [x] rip store 阶段流转（fetch/convert/burn、percent null、空闲 no-op）—— `apps/web/test/store/rip.test.ts`。
- [x] downloadPlaylist 写 `meta.json`（文件名回填、封面引用、skipped、文件名补零位宽）—— `apps/web/test/lib/downloadPlaylist.test.ts`。
- [x] RipDialog 门控与选择回填（默认数字、非本机禁用、无刻录机、ffmpeg 缺失、超时长、跨源、取消/Esc）—— `apps/web/test/components/RipDialog.test.tsx`。
- [x] burn 链路（ES 先于 POST、done/error 收敛、陈旧终态过滤、watchdog）—— `apps/web/test/lib/burn.test.ts`。
- [x] 服务端校验器 / 卷标清洗 / 封面白名单 / 回环三例 / 数据与音频 CD 编排 / 409 / fail-fast —— `apps/server/test/rip.test.ts`。
- [x] PS 模板守卫（ASCII-only、关键 API、无 `${` 残留）/ parsePsLine / 错误映射 / 模拟缝 —— `apps/server/test/imapi.test.ts`。
- [x] ffmpeg 解析顺序与 CD-DA 参数 —— `apps/server/test/ffmpeg.test.ts`。
- [x] E2E：数字分发 ZIP 含 meta.json；数据 CD 模拟刻录下载 meta.json；音频 CD 观察 burn 阶段 —— `test/rip.spec.ts`。
- [x] `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` 全绿。

## 真机验证清单（插盘机，"插盘即用"）

1. `pnpm --filter @pterosaur/server rip:probe`：无盘 → 空刻录机列表；插空白 CD-R → 1 台 + `CD-R（可刻录）`。
2. dev 起服务 → 翻录对话框状态行与事实一致（刻录机数 / 介质态 / 重新检测）。
3. 数据 CD 3 首：资源管理器可读，含音频 + `cover.<ext>` + `meta.json`；浏览器同时下载 `meta.json`。
4. 音频 CD 3 首：通用播放器可放、曲序正确。
5. 非空白盘 / DVD 盘 → 明确拒绝文案且未写盘。
6. 拔出刻录机 → capabilities 禁用实体并给原因。
7. 刻录中关页面重开 → `status` 可查（已知边界）。

## 完成定义

- 如何判定已完成：单测 / E2E 全绿且覆盖上述验收项；模拟缝下（`PTEROSAUR_RIP_FAKE_BURN=1`）全链路可演练；在带刻录机的目标机按清单完成 1–4 项人工确认。
