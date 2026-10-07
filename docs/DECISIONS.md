# DECISIONS

本文件记录 Pterosaur 重写（Vue → React 19）过程中的关键技术决策。

## ADR-001：以同源后端代理网易云音源，而非纯前端直连

- 日期：2026-10-02
- 状态：已采纳
- 背景（遇到了什么问题）：目标是「无需登录、随意畅听」。原 Vue 项目靠 `api.paugram.com` 解析网易云 ID，得到 `music.163.com/song/media/outer/url?id=...` 这种地址，它会 302 跳到 `http://m***.music.126.net/....mp3`。实测发现两个硬约束：(1) 真实音频地址是 `http://`，在 https 页面上会被浏览器混合内容策略拦截；(2) 跳转端点与部分接口没有 CORS 头，浏览器 `fetch` 拿不到。纯前端方案在现代浏览器里根本放不出声音。
- 考虑过的方案：
  1. 纯前端直连（保留 paugram）——被混合内容 + CORS 否决。
  2. 纯前端 + 打包内置免版权示例音频——自包含可静态部署，但只能放内置的几首，无法「随意畅听」，与目标冲突。
  3. 引入公共 CORS 代理（allorigins / corsproxy.io）——实测超时或需 API key，不稳定且把用户请求交给不可信第三方。
  4. **自建同源后端代理**——前端只访问本域 `/api`、`/stream`，后端在服务端解析网易云、把 `http` 音频改写为 `https`、按 Range 转发。
- 决策：采用方案 4，自建后端代理。
- 为什么选这个：唯一能同时满足「海量真实曲库 + 免登录畅听 + https 可用 + 可控」的方案。后端还能顺带承接登录会话，为 VIP 解锁铺路。实测 Node 侧 `fetch` 解析重定向、改写 https 后 Range 请求返回 206 音频正常。
- 为什么不选其他：方案 1/3 技术上行不通或不可靠；方案 2 违背产品目标。
- 后果：
  - 生产部署必须运行 Node 后端（`pnpm start`），不能当纯静态站点。
  - 增加了一个需要维护的服务层与音频地址缓存。
  - 好处是前后端同源，部署到 https 服务器无需处理任何跨域/混合内容问题。
- 何时重新审视：若网易云放开官方 CORS 或提供 https 音频直链；或产品决定转向「内置曲库 + 静态托管」的形态。

## ADR-002：后端选 Hono + @hono/node-server，并内置网易云登录

- 日期：2026-10-02
- 状态：已采纳
- 背景：需要一个轻量、TypeScript 友好、能与前端共享类型的后端；用户额外要求「支持登录自己的网易云账号以充分支持 VIP 曲目」。
- 考虑过的方案：Express（重、TS 体验一般）、Fastify（可以但生态偏 REST）、原生 `node:http`（太底层）、**Hono**（超轻量、Web 标准 `Request/Response`、TS 一等公民、`@hono/node-server` 可直接跑在 Node 且能托管静态资源）。
- 决策：后端用 Hono；网易云能力用 `NeteaseCloudMusicApi` 在 Node 进程内以函数形式调用（而非另起其 HTTP server）；登录用网易云**扫码**（`login_qr_*`）。
- 为什么选这个：Hono 让「同一进程既发 API 又发 SPA 静态资源」非常自然，天然同源；`NeteaseCloudMusicApi` 以库形式调用省掉一层进程与端口，且其加密签名逻辑现成可用。扫码登录把 cookie 通过 Set-Cookie 下发浏览器，后续请求自动回传、后端透传即可解锁 VIP。
- 为什么不选其他：Express/Fastify 与「共享 TS 类型 + 静态托管 + 极简」的诉求不如 Hono 贴合；自建网易云加密签名成本高且易随上游变动失效。
- 后果：
  - 后端无业务状态（仅音频地址 LRU 缓存），可水平扩展。
  - 登录态是用户本人网易云 cookie，仅存其浏览器，后端不持久化凭证。
  - 依赖 `NeteaseCloudMusicApi` 的接口形态：参数扁平（`{keywords, limit}`）、返回 `cookie` 为 Set-Cookie 字符串数组——已在 `server/netease.ts` 收敛。
- 何时重新审视：`NeteaseCloudMusicApi` 停止维护或网易云大改加密协议时。
- 后续修订：「后端不持久化凭证」已被 ADR-014 打破——服务端为未登录访客新增了一份**可选的缺省凭证**（`.env` 中的 `NETEASE_COOKIE`）。

## ADR-003：前端用 React 19 + Vite 8 + Zustand，状态按领域拆分

- 日期：2026-10-02
- 状态：已采纳
- 背景：用户指定 Vite + React 19 重写。需要一套轻量、可持久化、选择器友好的状态方案承载播放器这种高频更新的应用。
- 考虑过的方案：Redux Toolkit（样板多、对播放器偏重）、Jotai/Valtio（原子化，播放器状态是强关联的整体，拆分反而别扭）、Context + useReducer（高频 position 更新会导致大范围重渲染）、**Zustand**（极简、选择器订阅天然规避无关重渲染、内置 `persist` 中间件）。
- 决策：Zustand，按领域拆四个 store——`player`（播放状态机）、`library`（收藏/最近/本地歌单）、`auth`（登录态）、`ui`（临时浮层开合）。前三者用 `persist` 落 localStorage，`ui` 不持久化。
- 为什么选这个：播放器每秒多次更新进度，Zustand 的选择器订阅让「只有用到该字段的组件」重渲染，性能与心智负担都低；`persist` 让「免登录也能记住收藏/最近播放」开箱即用。按领域拆分避免单一巨型 store。
- 为什么不选其他：Context 方案扛不住 position 的高频更新；Redux 对本项目偏重。
- 后果：
  - `player` store 持久化时用 `partialize` 只存列表与偏好，冷启动重置为暂停态（不恢复「正在播放」，避免浏览器自动播放策略报错）。
  - 进度 seek 单独走 `audioElement.seekTo()` 命令式路径，不经 store 订阅，避免 rAF 回写与拖拽互相覆盖。
- 何时重新审视：若引入服务端渲染或需要跨标签页实时同步播放状态。

## ADR-004：播放进度用命令式 seek + rAF 单向回写，而非双向绑定

- 日期：2026-10-02
- 状态：已采纳
- 背景：`<audio>.currentTime` 既被播放自然推进，又被用户拖拽修改。若用 store.position 双向绑定，rAF 的高频回写会与用户拖拽的目标值互相覆盖，导致进度条抖动、拖不动。
- 考虑过的方案：(1) position 完全由 store 驱动、audio 受控——抖动；(2) 拖拽期间本地 state、松手 commit——可行但 seek 与 store 仍可能打架。
- 决策：进度单向回写——`useAudioEngine` 用 rAF 把 `audio.currentTime` 写进 store 供 UI 渲染；用户拖拽/快进/点歌词则调 `audioElement.seekTo()`，它**同时**写 `audio.currentTime` 与 store，一次到位。
- 为什么选这个：区分「音频是真相源（自然播放）」与「用户意图是真相源（拖拽）」两种场景，各自单向，杜绝循环覆盖。
- 后果：任何需要跳转播放位置的 UI（进度条、快捷键、歌词行）都必须走 `seekTo()`，不能直接 set store.position。
- 何时重新审视：基本稳定，除非改用 Media Source Extensions 之类的自定义缓冲方案。

## ADR-005：E2E 面向「生产形态」运行（build 后由 Hono 同源提供）

- 日期：2026-10-02
- 状态：已采纳
- 背景：本项目的正确性高度依赖「同源代理 + https 音频改写 + Range 串流」，这些只在后端在场时才成立。若 E2E 只跑 Vite dev（前端 mock 后端），测不到真正的播放链路。
- 决策：Playwright 的 `webServer` 先 `vite build`，再以 `NODE_ENV=production` 启动 Hono（同时发 SPA 与 API），E2E 断言真实音频播放（`audio.paused===false` 且 `currentTime` 随时间前进）、真实歌词加载、真实 Range 响应。
- 为什么选这个：与线上部署形态一致，测的是用户真正会走的路径，能抓到「dev 能跑、prod 挂」这类问题。
- 后果：E2E 依赖真实网易云上游，存在网络波动风险；已用较长超时与 `.poll()` 缓解，并对「免费可播曲目」做断言以规避 VIP 不确定性。
- 何时重新审视：若上游不稳定导致 CI 频繁 flaky，可对网络层做录制回放（fixture）改造。

## ADR-006：git 历史作者与提交信息按实际重写，保留作者时间

- 日期：2026-10-02
- 状态：已采纳
- 背景：原仓库三条历史提交作者为他人（Penyo），提交信息笼统（如「feat: add many functions」「feat: commit very firstly」）。用户要求按实际情况重写信息、作者统一改为 `杏仁鹿 <krkr@xrl.im>`，且**作者时间不变**。
- 决策：先用 `git bundle` 备份原始历史到仓库外（`/tmp/pterosaur-original-backup.bundle`）；再用 `git filter-repo` 统一作者/提交者并重写信息；因 filter-repo 会给正文加两空格缩进，改用 `git commit-tree` 以既有 tree + 原 author/committer 日期逐条重建，得到干净无缩进的提交信息。
- 为什么选这个：`commit-tree` 能逐字控制 message 与四个时间戳（author date / commit date 各自保留），比重放 patch 更精确；bundle 备份保证可回退。
- 后果：三条历史提交的 SHA 全部改变（tree 内容逐字节不变，已校验）；本地历史与 `origin` 分叉，推送需 `--force-with-lease`（尚未推送，留待用户决定）。
- 何时重新审视：不涉及。若需恢复原历史，从 bundle 重新 clone 即可。

## ADR-007：搜索分为歌曲 / 艺人 / 专辑 / 歌单四类，并新增艺人页、专辑页

- 日期：2026-10-03
- 状态：已采纳
- 背景：原搜索只返回单曲（`cloudsearch type=1`）。需求要把结果分为四类 tab；同时歌单内的艺人名 / 专辑名要能点击跳转到详情页——而原 `Track` 模型只有艺人名与专辑名的字符串，没有 id，也**没有**艺人页 / 专辑页。
- 考虑过的方案：① 前端对 `cloudsearch` 做四次调用；② 后端合并为一个 `/api/search/all` 端点；③ 只做歌曲 + 前端过滤（无法得到艺人/专辑实体）。艺人/专辑详情：复用 `artists`（档案 + 热门单曲）与 `artist_album`、`album`（档案 + 曲目）。
- 决策：后端新增 `/api/search/all`（内部 `Promise.all` 四次 `cloudsearch`，类型码 1/10/100/1000）、`/api/artist/:id`、`/api/album/:id`；`Track` **增量**新增 `artistRefs?: {id,name}[]` 与 `albumId?: string`，并新增共享 `Artist` / `Album` / `SearchResults`。前端新增艺人页 / 专辑页与曲目行内可点击链接。
- 为什么选这个：`cloudsearch` 单次请求只返回一种类型，并行四次是最直接的实现；把四次放后端可让前端一次请求拿到全部，切 tab 瞬时；`Track` 只做**增量**字段扩展，既有展示逻辑（`artist` / `album` 字符串）与持久化数据不受影响，缺失 id 的旧数据（收藏 / 最近 / 队列）自动降级为纯文本。
- 为什么不选其他：方案③ 拿不到艺人 / 专辑实体；把四次调用放前端会让四个组件的加载态各自为政，且要处理并发。
- 后果：每次搜索产生 4 个上游请求（艺人 / 专辑 / 歌单限额较小）；`useAsync` 增加可选 `cacheKey`（模块级内存缓存，命中即同步返回），使切换歌单 / 专辑时免于加载态、转场更顺滑。
- 何时重新审视：若网易云提供一次返回多类型的搜索接口。

## ADR-008：内容区转场自实现 View Transition，沉浸播放页用 presence + CSS 动画

- 日期：2026-10-03
- 状态：已采纳
- 背景：需求要求主内容区切换（如切换歌单）与进入 / 退出沉浸播放页达到 Apple Music / iOS 级观感。最初设想用 react-router v7 内置的 `viewTransition` 选项。
- 考虑过的方案：① RR7 内置 `viewTransition: true` / `<Link viewTransition>`；② 迁移到数据路由（`createBrowserRouter` + `RouterProvider`）后使用内置能力；③ 自实现 `document.startViewTransition`；④ 引入动画库（framer-motion）。
- 决策：②被排除后采用③——新增 `lib/viewTransition.ts` 的 `startRouteTransition(update)`：在支持该 API、未命中 `prefers-reduced-motion`、且无浮层打开时，`startViewTransition(() => { flushSync(update); resetContentScroll() })`；CSS 只给 `.app-content` 一个 `view-transition-name` 并置 `:root { view-transition-name: none }`，使**只有内容区**做交叉溶解（侧栏 / 顶栏 / 播放条静止）。导航统一走 `hooks/useViewNavigate` 与 `components/AppLink`。沉浸播放页改为**常驻挂载** + `hooks/usePresence`，用 CSS `np-enter` / `np-exit` 做上推进入、下滑退出。
- 为什么选这个：本项目用的是**声明式 `<BrowserRouter>`**，经核验 RR7 源码，该模式下 `useNavigate` 走 `useNavigateUnstable`，其 `navigator.push(path, state, options)` 会**忽略 `options`**，`startViewTransition` 只存在于 `RouterProvider` 路径——即内置 `viewTransition` 在本项目中是空操作（无转场、无告警）。自实现可绕开这一限制，且能精确控制「只动内容区」「浮层打开时跳过」等条件。
- 为什么不选其他：方案① 无效；方案② 改动面更大且每个调用点仍需逐个加选项；方案④ 为一个转场引入重依赖不值得。
- 后果 / 已知边界：
  - 浏览器前进 / 后退（`popstate`）与 Topbar 的前进后退按钮不参与转场（无法被同步包裹）。
  - Firefox 暂无原生支持 → 走 CSS 降级（`<html data-vt="off">` 时对 `.route-stage` 播放进场动画）。
  - 有浮层（队列 / 沉浸页 / 弹窗）打开时跳过转场——`::view-transition` 伪树绘制在 top layer，否则会盖住这些 `position: fixed` 浮层。
  - `view-transition-name` 必须文档内唯一——只给 `.app-content` 命名，绝不给列表行 / 卡片命名（否则整段转场被跳过）。
- 后续修订：沉浸播放页的转场已由 **ADR-018** 升级为 View Transitions **共享元素**（封面 morph）；本条中的 `usePresence` + `np-enter`/`np-exit` 上滑仅作**无 VT 时**的降级。
- 何时重新审视：若把路由迁移到数据路由，可回退到内置 `viewTransition`。

## ADR-009：CSS 压缩会合并 `backdrop-filter` 前缀对，标准属性须写在最后

- 日期：2026-10-03
- 状态：已采纳
- 背景：给队列面板加毛玻璃时发现，构建产物中**未加前缀的 `backdrop-filter` 被丢弃**、只剩 `-webkit-backdrop-filter`（源码里两条都在、值相同）。Firefox 支持未加前缀的 `backdrop-filter` 而不支持 `-webkit-` 前缀，因此毛玻璃在 Firefox 会失效——侧栏 / 顶栏 / 播放条等既有毛玻璃其实早就受影响，只是不明显。
- 决策：把所有毛玻璃规则统一改为 `-webkit-backdrop-filter` 在前、`backdrop-filter` 在后的顺序（`Sidebar` / `Topbar` / `PlayerBar` / `QueuePanel` / `NowPlaying` / 各弹窗）。这样压缩后两条都会保留。
- 为什么选这个：实测交换顺序后构建产物同时保留两个属性，Chromium（两条都支持）、Firefox（标准属性）、旧 Safari（前缀属性）都能得到毛玻璃；无需引入额外的 `@supports` 或构建插件。
- 后果：源码中该前缀对的顺序成为**有意义**的约束，后续新增毛玻璃样式需遵循。
- 何时重新审视：若更换 CSS 压缩器 / 配置其 targets，使未加前缀属性不再被丢弃。

## ADR-010：`normalizePlaylist` 等拼接触摸参数时兼容已有查询串

- 日期：2026-10-03
- 状态：已采纳
- 背景：封面 / 头像需要追加网易云缩略参数 `?param=WxH`。部分歌单封面（`coverImgUrl`）本身已带查询串，用 `?` 直接拼接会得到第二个 `?`，破坏地址。此前只在歌单封面出现、不易察觉；搜索页新增歌单 tab 后变得更明显。
- 决策：抽出 `thumb(url, param)` 辅助函数：地址已含 `?` 时用 `&` 连接，否则用 `?`。`normalizeTrack` / `normalizeArtist` / `normalizeAlbum` / `normalizePlaylist` 及 `playlistTracks` 统一走它。
- 后果：封面地址不再出现重复 `?`；歌单封面在浏览器中可正常加载。
- 何时重新审视：不涉及。

## ADR-011：library 持久化从 localStorage 迁到 IndexedDB，并以微任务级写合并节流

- 日期：2026-10-03
- 状态：已采纳
- 背景：`store/library.ts` 原用 `persist` + `createJSONStorage(() => localStorage)` 且无 `partialize`。`persist` 在**每次 `set()` 都把整个库 `JSON.stringify` + 同步 `setItem`**，而 `addRecent` 挂在**每次切歌**上（`useAudioEngine.ts`）。两个问题：(1) 主线程同步序列化/写盘，切歌/收藏时掉帧；(2) localStorage ~5MB 配额天花板，`playlists[].tracks` 存完整 `Track` 造成重复存储，重度用户触顶后**静默丢写**。
- 考虑过的方案：① 维持 localStorage，仅加 `partialize` 裁字段；② 迁 IndexedDB，`createJSONStorage` 存 JSON 串；③ 迁 IndexedDB，自定义 `PersistStorage` 用 structured clone 直接存对象；④ 迁 OPFS / 服务端。写节流上：⑤ 定时 debounce（~300ms）+ `pagehide` flush；⑥ 微任务级合并。
- 决策：③ + ⑥ + 一次性迁移。新增 `lib/idb.ts`（纯 IDB 封装，主线程与 SW 共用）、`lib/coalesceWrites.ts`（微任务级写合并）、`lib/libraryStorage.ts`（IDB `PersistStorage` + 旧 localStorage 数据惰性迁移）。store 改为 `storage: libraryStorage` + `skipHydration: true` + **`partialize` 只存数据字段**；`main.tsx` 渲染前 `await rehydrate()`。
- 为什么选这个：IDB 写入**异步、不阻塞主线程**，且配额远大于 localStorage，直接解决两个原问题。用 structured clone 免掉 `JSON.stringify` 的主线程 CPU。列表类数据可被合并，故用微任务级合并（同一 tick 内多次 `setItem` 只落最后一次）—— 保留合并收益而**没有时间窗口**。
- 为什么不选其他：① 治标不治本（仍受 5MB 限额与同步写）；② 仍要 `JSON.stringify`；④ 过重。**⑤ 被否决**：底层是异步 IDB，浏览器无法在页面卸载时保证事务提交，任何 `delay > 0` 都会让「收藏/建歌单后立刻刷新或硬跳转」丢失最后一次写入（已由 E2E 复现并据此改设计）。**必须**给 library 加 `partialize`：`persist` 默认持久化整个 state（含 action 函数），而 IDB 的 structured clone **无法克隆函数**，直接 `put` 会抛 `DataCloneError`——这是迁到 IDB 后才暴露、localStorage（JSON 静默丢弃函数）时代不存在的约束。
- 后果 / 已知边界：
  - `store/library.ts` 新增 `partialize`（仅 favorites/recent/playlists/savedPlaylists/savedAlbums；**后续修订**：ADR-017 增加 `savedArtists`）。
  - 一次性迁移写在 `libraryStorage.getItem` 内：读到旧 `localStorage['pterosaur-library']` 即写入 IDB 并删除旧键（键存亡即幂等标记）；`getItem` 因此有一次性副作用（读时写），可接受。
  - 持久化变为异步：`main.tsx` 在 `createRoot().render()` 前 `await rehydrate()`，避免首帧空库闪烁。
  - **dangling 写入窗口**：写入是异步的，硬导航（刷新 / 输入地址 / 外链）发生在写入提交之前理论上会丢最后一次写；应用内跳转走客户端路由（不重载）不受影响，`pagehide`/`visibilitychange` 有兜底 flush。E2E 中**硬跳转/reload 前用 `waitForLibraryPersisted` 轮询 IDB 落盘**规避竞态。
  - 测试：`fake-indexeddb` 注入 `test/setup.ts`；E2E 由「写 `localStorage` 封套」改为「在页面上下文写 IDB」。
- 何时重新审视：若引入 OPFS 或需要跨标签页同步；或 `Track` 体积进一步膨胀需要把 `playlists[].tracks` 归一化为引用。

## ADR-012：播放过的音频用 Service Worker + IndexedDB 缓存（16GB 上限，LRU 淘汰）

- 日期：2026-10-03
- 状态：已采纳
- 背景：希望播放过的曲目本地留存，实现即点即播 / 离线。后端 `/stream/:id` 写死 `Cache-Control: no-store` 且无 `ETag`，**浏览器 HTTP 缓存被完全禁用**；因此缓存必须由应用层承担。`/stream/:id` 路径稳定（key = `track.id`），且上游真实 CDN 地址由后端隐藏、对客户端不可见。
- 考虑过的方案：① 播放前先整文件拉进 IDB 再用 blob 播放（单一流量，但首播要等整首下载完，无渐进播放）；② 播完后另起一次 `fetch` 抠整文件存 IDB（保留流式，但每首首次约 2× 流量）；③ **Service Worker 拦截 `/stream/*`**，单次下载、边流式播放边缓存；存储用 Cache Storage 还是 IDB。
- 决策：③，且**存 IDB**。新增 `src/sw.ts`（独立 Vite 构建产出单文件 `sw.js`）+ `lib/audioCache.ts`（纯逻辑：缓存 key、Range 切片、LRU 计算 —— 主线程与 SW 共用）。SW 只拦截 `/stream/*`，其余请求原样放行。未命中时 `fetch(url)`（去掉 Range 取整文件）→ `clone()` 一路流式返回给页面播放、一路 `blob()` 写 IDB；命中时按请求 `Range` 返回 200/206。blob 与元数据分存两个 store（`audio` / `audioMeta`），使 LRU 淘汰只遍历轻量元数据、不触碰 blob。容量上限 `min(16GB, navigator.storage.estimate().quota * 0.9)`，超出按 `lastAccess` 升序淘汰；启动时 `navigator.storage.persist()` 申请持久化。
- 为什么选这个：SW 拦截是唯一能**单次下载 + 保留流式播放 + 透明缓存**的方案；`audio.src` 无需任何改动。存 IDB 而非 Cache Storage 是因为需要按曲目元数据（`lastAccess`）做 **LRU 与用量统计**，Cache Storage 无内建元数据/索引。缓存 key 用 `${id}|${level}`（前端恒用默认 `exhigh`），排除登录态（同一 level 下字节一致，登录只影响能否解析）。
- 为什么不选其他：①②都要么牺牲首播体验、要么翻倍流量；Cache Storage 不便做 LRU 记账。
- 后果 / 已知边界：
  - 新增 `sw.js` 构建步骤：`apps/web/vite.config.sw.ts` 单独构建（IIFE、无 hash、`emptyOutDir: false`），**必须在主构建之后**运行。
  - SW 只碰 `/stream/*`，对路由、HMR、其它资源零影响；dev 下可选以 module SW 注册（`/src/sw.ts`），prod 用 `/sw.js`。
  - 仅缓存 `200/206` 且 `content-type` 为 `audio/*` 的响应；`403`（VIP 未登录）/`502` 直接放行不缓存。
  - IDB 无流式写入：整文件需短暂驻留内存（单曲数 MB~数十 MB）。
  - 16GB 为**自设上限**，浏览器实际配额可能更低且可能在存储压力下回收，故 UI 应提供「清空缓存」入口（`audioUsage` / `clearAudioCache`）。
- 何时重新审视：若浏览器对 Cache Storage 的淘汰/配额行为更适合该场景；或需要边下边存（分片写入 IDB）。
- 后续修订：音频本身仍是手写 IDB 逻辑；但「应用外壳缓存」随后改用 Workbox 运行时缓存，且封面也并入同一 IDB 池 —— 见 ADR-013。
- 后续修订：seek 型 `Range`（起点 > 0 / 后缀）不再经 SW——同步判定后不接管、由浏览器直接请求同源接口。旧实现未命中缓存时去掉 `Range` 取整文件，seek 请求收到 200 全量（无 `Content-Range`）后无法完成跳转（`seeking` 停在 `waiting/stalled`；播放侧停滞看门狗只能以「重载 + 回拨」反复兜底，且每次重载又触发一次整文件请求）。SW 只处理整文件请求（无 `Range` / `bytes=0-` 前缀，命中缓存直接由 IDB 返回）与封面；整文件缓存写入改用 `event.waitUntil`（音频与封面一致），避免 SW 被回收导致缓存永不落库。**已知取舍**：已缓存曲目的 seek 也不再由 IDB 切片服务（联网时多一次网络请求；离线时仅能在已缓冲区间跳转）。

## ADR-013：引入 vite-plugin-pwa（应用外壳 7 天过期）+ 封面经 SW 落 IDB（与音频共用 16GB）

- 日期：2026-10-03
- 状态：已采纳
- 背景：应用此前不能安装、不能离线，应用外壳（HTML/JS/CSS）完全依赖网络与浏览器启发式 HTTP 缓存；封面图由 `<img>` 直连网易云 CDN，不经 SW、不落任何应用层缓存。目标：(1) 可安装、离线可用的 PWA，且外壳缓存不能无限陈旧；(2) 封面与音频一样作为非结构化数据落进 IndexedDB，二者共用同一个容量预算。
- 考虑过的方案：PWA 集成——① `generateSW`（默认）；② `injectManifest` 复用现有 `src/sw.ts`。外壳缓存——③ precache（Workbox 默认）；④ runtime caching + `ExpirationPlugin`。封面获取——⑤ 新增后端 `/img` 同源代理；⑥ SW 以 CORS 重新拉取原 CDN 地址。
- 决策：② + ④ + ⑥。引入 `vite-plugin-pwa@^1.3.0`，`strategies: 'injectManifest'` 让现有手写 SW 成为**唯一** SW（`rollupFormat: 'iife'` 保持经典非模块 SW；`injectRegister: false`，仍由 `main.tsx` 手工注册）；应用外壳改用 Workbox 运行时缓存（导航 `NetworkFirst`（缓存键归一为 `/index.html`）、同源 script/style `StaleWhileRevalidate`），`ExpirationPlugin({ maxAgeSeconds: 7 * 24 * 3600 })`；precache 收窄到静态图标/manifest。删除独立的 `vite.config.sw.ts` 与第二步构建。封面按 `destination === 'image'` 由 SW 接管，未命中时以 `mode:'cors', credentials:'omit'` 拉取（实测网易云 CDN 无条件返回 `access-control-allow-origin: *`），把**可读**字节写入与音频同一个 IDB 池。IDB 升到 v2：`audio`/`audioMeta` 更名 `media`/`mediaMeta` 并加 `kind: 'audio' | 'image'`。
- 为什么选这个：单一 SW 才能避免同作用域抢注册；runtime caching 才能表达「7 天有效期」（precache 条目永不过期，与需求直接冲突）；SW 侧 CORS 拉取无需改后端与图片 URL 生成，改动面最小；共用同一 meta store 使 LRU 天然跨音频 / 封面按 `lastAccess` 统一淘汰，正合「共用 16GB」。
- 为什么不选其他：① 会再生成一个 `sw.js` 与现有注册冲突；③ 与「外壳 7 天过期」矛盾；⑤ 需新增后端路由并改写图片 URL 生成，改动更大（且已明确不改后端）。
- 后果 / 已知边界：
  - SW 拦截范围由「仅 `/stream/*`」扩大为「`/stream/*` + 封面图片 + 同源导航 + 同源 script/style」；`/api/*` 与其它请求仍原样放行。
  - 封面缓存**依赖 CDN 的 CORS 行为**：若其变更，封面回退为「直连不缓存」（功能不受损，仅失去缓存）。
  - 离线语义：首次访问后外壳 / 封面才有缓存；外壳缓存超过 7 天未用即被清除，此后离线不可用——这是「7 天有效期」的预期行为。
  - IDB v2 升级会丢弃旧音频缓存（纯缓存，可接受），`library` 原样保留；`e2e` 的 IDB 辅助已同步到 v2。
  - 设置弹窗「检查更新」= 注销全部 SW 注册 + 清空 Cache Storage + `fetch(href, { cache: 'reload' })` 后 `location.reload()`；**不触碰 IndexedDB**，资料库与媒体缓存保留。
  - 构建：`apps/web` 的 `build` 回归单条 `vite build`，产出 `sw.js` + `manifest.webmanifest` + 图标；图标提交进仓库（CI 无需浏览器 / sharp）。生成器源为 `apps/web/assets/pwa-icon.svg`（**不放 `public/`**，避免作为站点资源发布、也不再进 precache）；生成器固定会多产出 64px / maskable / `.ico` 等无用文件，**只保留 4 个**：`favicon.svg`（标签页，`index.html` 引用）、`pwa-192x192.png`、`pwa-512x512.png`、`apple-touch-icon-180x180.png`，且 512 那张直接兼作 maskable（全出血红底、图形落在安全区）。重新生成：对源跑 `pnpm dlx @vite-pwa/assets-generator@latest --preset minimal-2023 apps/web/assets/pwa-icon.svg`，再把所需产物移入 `public/`。
  - **开发态作用域**：dev 下 SW 源码位于 `/src/sw.ts`，其默认作用域会被限制为 `/src/`，SW 便永不控制 `/` 下的页面、缓存恒为空。故 `vite.config.ts` 加了一个 dev 中间件为该响应补 `Service-Worker-Allowed: /`，`main.tsx` 再以 `scope: '/'` 注册；生产由 `/sw.js` 天然位于根作用域，无需此插件。
- 何时重新审视：若希望离线首帧即用外壳（放弃 7 天过期，改用 precache）；若网易云 CDN 关闭 CORS（需改走后端代理）；若引入 OPFS。

## ADR-014：服务端缺省凭证（`pnpm log-in`）——未登录访客共享运营者账号解锁 VIP

- 日期：2026-10-03
- 状态：已采纳
- 背景：此前 VIP 曲目只有「登录了本人网易云账号」的访客才能播放（见 ADR-002），匿名访客只能听免费曲目——与产品定位「无需登录、随意畅听」（ADR-001）相矛盾。需要一份「缺省账号」在访客未登录时代为解析 VIP 资源，且不得影响访客自身身份与其后续登录。
- 考虑过的方案：① 前端内置一份 cookie——随前端产物暴露给所有访客，泄露面最大，否决；② 把 cookie 写死后端源码——同样入库即泄、难以轮换；③ **CLI 扫码登录 → 落盘 `.env` → 服务端按需读取**；④ 硬编码「公开共享账号」——无法轮换与审计。
- 决策：方案 ③。新增 `pnpm log-in`：起一个**仅监听回环地址**的本地网页，扫码成功后把会话 cookie 写入**仓库根 `.env`** 的 `NETEASE_COOKIE`（并记 `NETEASE_COOKIE_UPDATED_AT`）。服务端启动时 `loadEnv()`；请求处理时以 `credentialOf(c) = cookieOf(c) ?? process.env.NETEASE_COOKIE` 提供**内容接口**（搜索 / 歌单 / 艺人 / 专辑 / 歌曲详情 / 歌词 / `/stream`）所需凭证；**身份接口**（`/api/auth/status`、`/api/user/playlists` 等）仍只看访客本人 cookie。`.env` 不入库（`.gitignore` 已忽略），另提供可入库的 `.env.example`。
- 为什么选这个：扫码只做一次、凭证落在部署者自己的机器上而不经过源码；`.env` 与既有的 NODE_ENV/PORT/HOST 约定一致；`credentialOf` 单点回退让「匿名可听 VIP、登录仍以本人为准」的语义清晰；前端零改动（同源铁律不变）。
- 为什么不选其他：①/②/④ 都会把长期凭证写进仓库或前端产物，泄露面最大且难以轮换。
- 后果 / 已知边界：
  - **这是 ADR-002「后端不持久化凭证」的例外**：服务端会持久化一份**缺省**凭证——它属于运营者，不属于任何访客。建议使用**专用账号**，并评估网易云对异地 / 多端登录的风控。
  - 缺省凭证同样作用于 `/api/discover/recommend`，故匿名首页的个性化推荐来自该账号。
  - 音频地址缓存键由「有无 cookie」布尔改为**凭证指纹**（cookie 的短哈希），避免不同账号串用解析出的 CDN 地址。
  - `.env` 变更**需重启服务**生效（`process.env` 不在运行期热更新）；`pnpm log-in` 结束时会打印该提示。
  - 未配置 `NETEASE_COOKIE` 时，行为与改动前完全一致（访客仍凭本人登录）。
- 何时重新审视：若引入多缺省账号 / 凭证自动轮换；若网易云风控使共享账号不可用；若产品改为「必须登录才能播放」。

## ADR-015：封面缓存按固定 TTL 7 天过期（音频不受影响）

- 日期：2026-10-03
- 状态：已采纳
- 背景：媒体缓存（音频 + 封面）共用 16GB LRU，淘汰只看 `lastAccess`，**没有任何时间维度**；而应用外壳已用 Workbox `ExpirationPlugin` 做 7 天过期（ADR-013）。需求：让封面也与外壳对齐——**缓存 7 天后自动过期**。
- 考虑过的方案：过期语义——① 固定 TTL（从**写入时刻**起算，到期必回源）；② 滑动窗口（从**末次访问**起算，常看则不过期）；③ 不为封面设过期。
- 决策：①。`MediaMeta` 增 `cachedAt`（写入时刻）；新增纯函数 `isExpired(meta, now)`（`kind==='image'` 且 `now - (cachedAt ?? 0) >= IMAGE_TTL_MS`）与 `expiredKeys`；SW 在命中时若已过期则 `deleteCached` 并按未命中回源，启动 `loadState` 时顺带清扫一遍。音频 `kind==='audio'` 永不过期。
- 为什么选这个：① 与外壳「7 天有效期」的固定寿命语义一致，且字面对应需求「7 天自动过期」；② 会让常看封面永不刷新，与「到期」相悖；封面体积小、回源廉价，固定 TTL 的额外一次下载可忽略。
- 为什么不选其他：② 语义不符；③ 违背需求。
- 后果 / 已知边界：
  - 封面自写入起 7 天后，下次访问必回源刷新一次（每 7 天每封面最多一次）。
  - 旧数据无 `cachedAt` → `isExpired` 以 `0` 计 → 判为过期，首次访问平滑刷新，无需迁移。
  - 音频仅受 LRU 淘汰，不受本 TTL 约束。
- 何时重新审视：若封面 URL 变得易变（需更短 TTL）；若希望离线长期保留封面（应取消过期）。

## ADR-016：library 云同步——LWW + 服务端文件型存储（打破「无状态后端」）

- 日期：2026-10-03
- 状态：**部分修订 by ADR-038**（存储改 SQLite、冲突策略改「云端权威」、新增 SSE）；激活条件与「身份只取本人 cookie」的边界仍有效
- 背景：library（收藏 / 最近 / 自建歌单 / 收藏的网易云歌单 · 专辑）此前只存本机 IndexedDB（ADR-011），换设备即丢。需求：登录后于头像菜单新增「云同步」开关（默认关闭），开启后支持**多设备同步**。
- 考虑过的方案：合并策略——① LWW（最新修改为准，整份覆盖）；② 两端并集合并。服务端存储——③ 文件型 JSON；④ 内存；⑤ 引入数据库。范围——仅 `library`。
- 决策：① + ③。新增 `server/syncStore.ts`（`<DATA_DIR|仓库根/.data>/sync/<userId>.json`，**原子写** tmp→rename，形状与体积校验）；路由 `GET/PUT /api/sync/library` 以**访客本人 cookie** 解析 `userId`（身份接口，**绝不回退缺省凭证**），未登录 401。前端新增 `store/sync.ts`（持久化 `enabled` / `userId` / `updatedAt`）、`lib/sync.ts`（`decideSync` LWW 决策 + 订阅 library 变更防抖推送 + `applying` 回声抑制）、`hooks/useLibrarySync.ts`（挂 `App`）；开关在头像菜单、**「退出登录」上方**，默认关。
- 为什么选这个：① 语义直观（本地或云端更新的那一份胜出）、**删除会随整份文档一并同步**、实现与验证简单；③ 零新依赖、契合单机自托管部署（pm2 在仓库根启动），`DATA_DIR` 可覆盖；按 `userId` 隔离且只用本人 cookie，杜绝越权与「把匿名访客当成运营者」。
- 为什么不选其他：② 不传播删除（别端会把删掉的条目带回来）、实现更复杂；④ 重启即失；⑤ 对一个自托管单机播放器过重。
- 后果 / 已知边界：
  - **这是「无状态后端」原则的第二个例外**（第一个是 ADR-014 的缺省凭证）：服务端开始**持久化访客本人的 library**。ADR-002 与 ARCHITECTURE 的相关措辞已同步修订；多实例水平扩展不再成立（文件存储不共享）。
  - LWW 为**整份覆盖**：两端离线各改后重连，后推送者覆盖前者（已与用户确认接受）。
  - 激活条件：开关开启 **且** 已登录 **且** `sync.userId === 当前 userId`；换账号自动失活（不为新账号悄然开启）。关闭开关仅停止同步，不删云端副本。
  - `.data/` 已被 `.gitignore` 忽略；部署流程（pm2 在仓库根）不会清空它，`DATA_DIR` 可改。
  - **设置「重置」联动**：已开启云同步时，先推送一份空 library 清空云端副本，再清本机（顺序不可颠倒）——见 ADR-015 同期改动的 `lib/reset.ts`。
  - 云同步 E2E 依赖真实扫码登录（无法自动化），以单测（`syncStore.test.ts`、`lib/sync.test.ts`）+ 手动验证覆盖。
- 何时重新审视：若需记录级 / 字段级合并与冲突保留；若引入多实例或数据库；若需要同步 `player` 播放态。

## ADR-017：艺人亦可收藏；唱片盒改为「艺人 + 专辑」双分区；同步校验只校验基础字段（宽容解析）

- 日期：2026-10-04
- 状态：已采纳
- 背景：此前收藏能力覆盖曲目 / 歌单 / 专辑，「唱片盒」（`/crate`）**只**展示收藏的专辑。需求：**艺人也可收藏**，且唱片盒同时容纳收藏的**艺人 + 专辑**。
- 考虑过的方案：收藏入口——① 仅艺人详情页红心；② 详情页红心 + 艺人卡片悬浮红心。唱片盒布局——③ 一页上下两分区；④ 顶部 tab 切换。同步校验——⑤ 把 `savedArtists` 并入必填集合；⑥ 只校验基础字段、对其余字段一概放行（宽容解析）。
- 决策：② + ③ + ⑥。`LibraryData` 增加 `savedArtists`（`store/library.ts` 增 `toggleSaveArtist` 并同步 `partialize` / `snapshotLibrary` / `emptyLibrary`）；`ArtistCard` 由 `<button>` 改写为 `div[role=button]` 并内嵌 `.card__fav` 红心（`<button>` 不能嵌套按钮，对齐 `AlbumCard` 范式）；艺人详情页红心照搬 `AlbumPage`；服务端 `isSyncEnvelope` 采用⑥（只校验基础集合，**不枚举后续新增字段**）。
- 为什么选这个：②「搜索到即收藏」，与专辑卡片的悬浮播放按钮范式一致；③ 一页看过全部收藏，契合「唱片盒」语义；⑥ **数据安全 + 抗污染**——若把 `savedArtists` 设为必填，旧云端文件（缺该字段）会被判为非法 → `readLibrary` 返回 `null` → 被当成「云端无数据」→ 新设备首开同步会用空库覆盖，**造成不可逆数据丢失**；而若为每个新增字段单开「必填 / 可选」判断，校验逻辑会随字段增长而污染，故只校验基础形状、其余字段一概放行。
- 为什么不选其他：① 少一个顺手入口；④ tab 每次只看一类、不如分区一目了然；⑤ 有数据丢失风险，且每加一个字段都要改校验（污染型）。
- 后果 / 已知边界：
  - 前端 `applyPayload` 以空库为底、用云端载荷覆盖（`{ ...emptyLibrary(), ...state }`），缺省处回落空值，**不逐字段枚举**；参数类型放宽为 `Partial<LibraryData>`。
  - 服务端 `isSyncEnvelope` 只校验基础形状、对新字段宽容：**不枚举后续字段**，避免校验逻辑随 library 扩展而污染。
  - LWW 整份覆盖的既有语义不变：旧云端载荷（无 `savedArtists`）被拉取时按 `[]` 处理；新客户端任何一次 push 都会把云端文档升级为 6 字段。
  - 卡片为 `div[role=button]` 内嵌红心按钮：键盘激活仅响应卡片本体（`e.target === e.currentTarget` 守卫），红心 `stopPropagation` 不进入详情页；`.card__fav--active` 常显强调色。
  - 唱片盒列表在**进入时冻结**（读一次 store 快照）：在页内取消收藏后卡片**不立即消失**（防误触），下次进入唱片盒才刷新。
  - 测试：`library.test.ts` / `sync.test.ts` / `syncStore.test.ts` 覆盖新字段与旧载荷兼容；E2E 新增唱片盒双分区 / 空态 / 艺人收藏（前两者走**本地种入、零联网**，规避网易云限流抖动）。
- 何时重新审视：若卡片需承载更多操作（播放 / 更多菜单）以至需要专门的操作栏。

## ADR-018：沉浸播放页改用 View Transitions 共享元素（封面放大）+ 当前曲目预载

- 日期：2026-10-04
- 状态：已采纳（**部分修订 ADR-008**：沉浸播放页的「presence + 上滑」降级为无 VT 时的兜底）
- 背景：ADR-008 中沉浸播放页只是「`usePresence` 延迟挂卸 + 整页 `translateY(100%)` 上滑（`np-enter`/`np-exit`）」，与封面本身**没有空间关联**，观感廉价；且首次打开有抖动——大封面重挂载闪占位、歌词现拉、大半径模糊背景首次栅格化。
- 考虑过的方案：① 纯 CSS 增强（更丰富的上滑 / 缩放）；② JS FLIP 手写封面位移；③ 复用 View Transitions 做**共享元素**（小封面 morph 成大封面）。
- 决策：③ + 预载。
  - 新增 `lib/nowPlayingTransition.ts` 的 `startNowPlayingTransition(next)`：支持 VT 且非 reduced-motion 时 `startViewTransition(() => flushSync(setExpanded(next)))`，否则直接 `flushSync`。
  - 封面命名 `np-cover`：PlayerBar 小封面在 `!expanded` 时持名（`PlayerBar.css`），NowPlaying 大封面在 `open` 时持名（`NowPlaying.css`，`data-vt='on'` 门控），**同一时刻仅一个元素持名**。
  - 背景 / 面板的入场交给 `.nowplaying` 上的 **live CSS 动画**（`np-vt-rise` / `np-vt-fade`，仅 `data-vt='on'`）；`np-enter`/`np-exit`/`np-rise` 收进 `:root[data-vt='off']` 降级分支。
  - `App.tsx` 的 `NowPlayingLayer`：VT 能力存在时**同步挂卸**（`show = expanded`，含 reduced-motion），仅在完全不支持 VT 时退回 `usePresence`。
  - 预载：`hooks/useNowPlayingPrefetch`（`current` 变化时 `preloadCover` + decode、`prefetchLyric`）；`lib/lyricCache.ts`（内存歌词缓存 + in-flight 去重）、`lib/imageCache.ts`（已解码封面 URL 表）；`Cover` 首帧按登记表显色。
- 为什么选这个：与 ADR-008 已建成的 VT 基建同构，是顺路径；封面 morph 正是 Apple Music 该转场的灵魂；预载让「点击即瞬时」。
- 为什么不选其他：① 仍缺与封面的空间关联，逃不出「简陋」；② 跨组件树手写 FLIP 需测矩形 + 临时浮层 + 处理挂载时序，代码量高一个数量级，还要复刻内部入场。
- 后果 / 已知边界：
  - **VT 的 DOM 更新回调必须同步**：回调里 `await rAF`（本想等新封面绘制）会**死锁**——转场期间浏览器暂停渲染，回调等 rAF、rAF 等回调结束 → 触发 UA 的「DOM update 超时」中止，并**连带破坏控件**（实测：歌词点击后容器 `scrollTop` 不再生效）。故回调只 `flushSync`，不 await。
  - **同步快照拍到的封面必须已可见**：因回调不能 await，改用 `lib/imageCache.ts` 的「已解码 URL 表」，`Cover` 首帧即按它就绪显色，避免快照拍到 `--bg-elevated-2` 占位底色。
  - **转场期必须摘掉 `.app-content` 的命名**：它是全站唯一命名元素，新旧快照内容相同 → UA 注入 plus-lighter 混合、伪树在 top layer 会**闪白并盖住沉浸页**；`data-np-vt` 于 `startViewTransition` **之前**设置、`finished` 后清除（resolve / reject 两分支都要清）。
  - **`openEntity` 不带走转场的收起**：否则与随后的路由转场重入（一个 VT 活跃期再起一个）。保持不转场的 `setExpanded(false)` —— 与 ADR-008 的路由转场衔接。
  - **只命名封面一个元素**：panel / bg / scrim 用 live 动画——避免命名导致的「live 内容被快照挖空」、歌词滚动冻结与额外全屏快照。
  - Esc / scrim / header 收起键统一走 `startNowPlayingTransition(false)`（`hooks/useKeyboardShortcuts.ts` 同步改）。
  - 完全不支持 VT 的浏览器：退回 presence + `np-enter`/`np-exit` 上滑（见 ADR-008）。
  - **模糊背景半径压到 40px**：全屏 + `scale(1.1)` 的 `blur(80px)` 光栅化偏贵，Chrome 会推迟其首次绘制——表现为「封面 / 歌词 / 控制都就位后，唯独模糊背景约一秒才补上」，重则整层空白、把后面的页面透出来（此前被 `scrim` 的 `backdrop-filter` 糊成「假背景」而掩盖，故长期未被察觉）。降到 40px 后绘制在 300ms 内稳定就位。
- 何时重新审视：若需 panel 入场曲线与封面严格同源（可改命名 panel/bg），或浏览器对「live 动画 + VT 并存」的处理有变。

## ADR-019：主题切换用 View Transitions 做「自按钮圆形揭示」

- 日期：2026-10-04
- 状态：已采纳
- 背景：切换明暗主题原本是**瞬时**的（改 store → 写 `<html data-theme>` → `tokens.css` 的 CSS 变量即刻换色），没有任何过渡。需求：切换时有观感更好的动画，而非单纯的配色渐变。
- 考虑过的方案：① 给颜色加 `transition`（配色渐变）；② 手写 CSS 圆 / 缩放动画；③ View Transitions 的 `clip-path: circle()` 圆形揭示。
- 决策：③。新增 `lib/themeTransition.ts` 的 `startThemeTransition(origin, apply)`：`startViewTransition(() => flushSync(apply))`，圆心取主题按钮中心、半径 `hypot(到最远角)`，经 `--theme-vt-x/-y/-r` 注入 `<html>`；`::view-transition-new(root)` 播放 `theme-reveal`（`circle(0px at …)` → `circle(r at …)`）。`components/Topbar.tsx` 的切换按钮改走此 helper。
- 为什么选这个：与既有 VT 基建（ADR-008 / ADR-018）同构；圆形揭示是 Chrome / Apple 熟悉的高级观感，且天然「从你点的位置展开」。
- 为什么不选其他：① 只是配色渐变，正是要避免的；② 手写圆 / 缩放动画难以覆盖侧栏 / 顶栏 / 播放条等 `position: fixed` 区域。
- 后果 / 已知边界：
  - **根快照的开关**：全站默认 `:root { view-transition-name: none }`（只让 `.app-content` 参与路由转场）；主题转场需**整页**参与，故改为 `:root:not([data-theme-vt]) { view-transition-name: none }`——转场期间给 `<html>` 打 `data-theme-vt` 即恢复根捕获，同时 `:root[data-theme-vt] .app-content { view-transition-name: none }` 摘掉内容区命名（免得它被从根快照挖掉）。标记在 `finished` 后清除（resolve / reject 两分支）。
  - **`useApplyTheme` 必须用 `useLayoutEffect`**：VT 新快照在 `flushSync` 返回后**同步**拍摄，`useEffect` 要到 paint 之后才跑，会把旧主题拍进新快照、令揭示失效。
  - **`mix-blend-mode: normal`** 覆盖 UA 对同源 old/new 层注入的 `plus-lighter`，避免中段提亮。
  - 揭示缓动用 `ease-in-out`（`--ease-ios` 前段过猛，圆几乎瞬铺满、过程不可见）。
  - reduced-motion / 不支持 VT：直连切换（保持原行为）。
- 何时重新审视：若想换揭示形态（斜切 / 缩放），或把该转场扩展到其它「全局换肤」场景。

## ADR-020：封面缓存键以「规范化 URL」去重——固定网易云镜像主机

- 日期：2026-10-06
- 状态：已采纳
- 背景：前端所有图片缓存都以 **URL 字符串**为键（SW 媒体池 `imageKey`、页面就绪登记表 `lib/imageCache.ts`、浏览器 HTTP 缓存）。实测验证（脚本对照同端点两次调用、搜索 vs 详情、同批响应）：网易云对**同一封面**会在 `p1`–`pN.music.126.net` 间**随机轮换主机名**，另有 http/https 混用——同端点两次调用即得 `p4`→`p3`，一批响应里 p1/p3/p4 并存；而**路径（`{hash}/{id}.jpg`）才是封面的稳定身份**。结果：同一封面被拆成多条缓存、命中率大幅下降，切歌 / 翻页时重复下载。曾考虑按「图片类型（歌曲/专辑/歌单/艺人）+ ID」作缓存键。
- 考虑过的方案：① 缓存键改「类型 + ID」；② 后端把封面代理为同源 URL（如 `/img/album/{id}`）；③ 保持以 URL 为键，但**先规范化**（https + 固定镜像主机 + 唯一 `param` 尺寸）。
- 决策：③。新增 `packages/shared/src/image.ts` 的 `canonicalNeteaseImage(url)`（仅匹配 `p\d+.music.126.net`，裸域与其它 CDN 原样放行；`param` 多个只留最后一个），并落到三处：server `netease.ts` 以 `coverUrl(raw, size)` 统一产出封面 / 头像（覆盖已有 `param`，消灭双参数碎片）；web `mediaCache.imageKey` 与 `imageCache` 就绪登记表均以规范化 URL 为键（旧持久化数据中的轮换前 host 与新数据互相命中）；NowPlaying 背景比较同样规范化。
- 为什么选这个：URL 规范化后即是「封面身份 + 尺寸」的稳定字符串，SW / 登记表 / HTTP 缓存 / 持久化数据**全端零结构改动**就完成去重；且**曲目封面即专辑封面**——同专辑 N 首曲共享一条缓存，这正是按路径（而非曲目 ID）去重的收益。
- 为什么不选其他：① 按曲目 ID 会把同一专辑封面重复存 N 份（键粒度错了；若一律升格为专辑 ID，则艺人头像 / 歌单封面又需各自类型分支），且 SW 无法从图片 URL 反查「类型 + ID」，需在页面维护映射表、复杂且有失败面；② 封面流量全部过自家服务器，带宽与延迟成本高，也违背「图片直连 CDN + SW CORS 拉取缓存」的既有设计（ADR-013）。
- 后果 / 已知边界：
  - 规范化固定使用 `p3.music.126.net`（p1–pN 互为镜像、内容一致）；若该主机异常，理论上可换常量 `NETEASE_IMAGE_HOST`，存量缓存键会整体失效一次（7 天 TTL 内自然冲销）。
  - 旧持久化数据（library / 队列）中的旧 host URL 无需迁移：SW 侧 `imageKey` 同样规范化，新旧字符串落同一条缓存。
  - 同一封面不同 `param` 尺寸仍是两条缓存（字节确实不同；当前全端尺寸固定：封面 600y600、头像 300y300）。
  - 音频流 URL **不经**此规范化（host 形态不同、且可能带时效签名，维持 `https()` 原样改写）。
- 何时重新审视：若网易云图片 URL 出现签名 / 时效参数（规范化需保留之）；若前端需要同一封面多档尺寸（可按「规范化 URL 去掉 param」再归并，接受首次尺寸升级重取）。

## ADR-021：弱网播放韧性——缓冲态可视化、停滞看门狗、截断校验与登录引导来源

- 日期：2026-10-06
- 状态：已采纳
- 背景：用户报告「网络不良时进度条还在走，但音乐已经停了」。复现与排查（含 Playwright 逐秒采样）确认了四条互不相同的静默路径：(1) 引擎只绑 6 个事件，`waiting`/`stalled`/`canplay` 全部无人监听，缓冲耗尽后 UI 永远停在「播放中」、无提示无恢复；(2) 弱网下切歌的 `play()` promise 既不 resolve 也不 reject，`isPlaying` 被钉死为 true；(3) 上游 chunked 流被截断时浏览器把已收数据当完整文件、提前触发 `ended`，而 `onEnded` 不校验时长直接切歌，弱网下逐首级联；(4) 音频元素的 `error` 事件无法区分「网络失败」与「VIP/版权受限」，原实现按 MediaError code 猜测，把网络故障也提示成「该曲目暂不可播放 + 登录解锁」。放大器：SW 回源丢 Range 取整文件、SW 与后端全链路无超时。
- 考虑过的方案：恢复手段——① `audio.currentTime = audio.currentTime` 触发重取；② `load()` 重载后回拨位置再播；③ 仅重调 `play()`。停滞判定位置——④ 引擎内嵌定时器；⑤ 独立纯逻辑模块 + rAF 逐帧喂快照。登录引导来源——⑥ 继续按 MediaError code 猜；⑦ 后端 403 经 SW `postMessage` 通知页面。
- 决策：⑤ + ② + ⑦，并补齐其余三项。新增 `src/lib/playbackWatchdog.ts`（纯逻辑、时间注入，便于单测）：`isPrematureEnd(audioDuration, trackDuration)` 以「`audio.duration` 比元数据时长短超过 **10s 且超过 10%**」双阈值判定截断（避开 VBR 估算误差误判，真截断通常差数十秒）；`createWatchdog` 以 `stallMs=5s`、退避 `[10s,15s,20s]`、`maxRetries=3` 判定停滞（**所有音源统一**，不做按源区分），**未起播（位置为 0）时不介入**，交由 12s 起播超时统一兜底。引擎逐帧驱动看门狗，`recover` 执行 `load()` + 回拨 `currentTime` + `play()`（`recovering` 标志豁免 `load()` 派发的那次 `pause` 回写），预算耗尽则暂停并提示、**不自动跳歌**。截断场景同一恢复流程，`ended` 不再一律切歌。起播 `play()` 以 `setTimeout` 超时（12s）兜底，`AbortError`（被 load/pause 主动中断）静默；元素处于错误态时先 `load()` 再播，保证故障排除后重试可恢复。缓冲态：`waiting`/`stalled` → `buffering=true`，`playing`/`canplay`/`pause` → false，播放键在缓冲中改显加载动画。登录引导改为⑦：`error` 一律中性文案，`needLogin` 仅由后端 403（`app.ts` 既有的 `fail(..., true)`）经 SW 广播 `STREAM_NEED_LOGIN` 驱动。超时：SW 回源 15s（仅响应头阶段）、后端上游 10s（仅响应头阶段），后端上游非 2xx 时淘汰 `urlCache` 项以便重新解析。
- 为什么选这个：第五条把判定逻辑与 DOM 副作用分离，可直接单测（10 个用例覆盖阈值、退避、清零、中断预算）；`load()` 是唯一能重建媒体管线、重新发起点播请求的手段（`currentTime` 自赋值多数浏览器会忽略，`play()` 不解决「数据已断」）；「未起播不介入」消除了看门狗与起播超时两份机制的互相打断（实测从互相抖动、27s 才闭环降为 12s 干净闭环）；登录引导改由后端 403 驱动后语义可靠，网络故障不再误导用户去登录。
- 为什么不选其他：①/③ 对已断流的元素无效；④ 定时器与 rAF 双时钟难对齐且不可测；⑥ 实测 code 4 既可能是真 VIP 也可能是网络失败（SW 超时后元素即报 code 4），按 code 猜必然误判。此外**不做** body 停滞超时与多路 tee 下载去重——前者需在音频关键路径包装流、引入新失败面，后者需 multi-tee 分发，复杂度/收益比不划算；截断与停滞已由前端兜底。
- 后果 / 已知边界：
  - 恢复用 `load()` 会丢弃已缓冲数据（有 3 次上限与递增退避；播放重新前进 >1s 即清零预算），**所有音源同一套退避**。
  - 看门狗由 rAF 驱动：**后台标签页不推进**，后台期间的停滞只能在切回前台后检测到（已知边界，未用定时器规避其双时钟问题）。
  - 截断双阈值是保守判据：差不足 10s 的截断按正常结束处理（宁可漏判，不可误判——误判会把正常播完的歌拖入恢复流程）。
  - 起播超时 12s 后若 `play()` 迟到 resolve，会因 `isPlaying` 已为 false 而被 `pause()` 抵消，行为自洽。
  - SW / 后端超时只覆盖连接建立阶段，长音频弱网慢速下载（body 阶段）不受影响，仍由 undici 300s / 生产 nginx 60s 兜底。
  - `buffering` / `playErrorNeedLogin` 为运行时字段，不在 `player` store 的 persist 白名单内，不持久化。
- 何时重新审视：若做音频分片缓存（ADR-012 提及「边下边存」），可据此实现精准续传而非整段重载；若需后台标签页的恢复能力，应改为 `setInterval` 驱动（并接受与 rAF 的时钟并存）；若网易云 CDN 改为稳定长连接，可下调重试参数。

## ADR-022：多源架构——实体带 `source`、`keyOf` 统一身份、`SourceAdapter` 归一化

- 日期：2026-10-06
- 状态：已采纳（**部分修订**：源清单改为 `MUSIC_SOURCES` + `MV_SOURCES` 双名单，见 ADR-033）
- 背景：项目原为单一音源（网易云），`Track` 的 `id` 是**全局唯一身份**，贯穿搜索产出 → 卡片 key / 跳转 → URL path → 页面取数 → 收藏/最近/歌单成员去重 → 队列定位 → 音频/歌词缓存键 → 后端 `/stream` 与 urlCache（约 60 个判等点位）。需求是接入第二个源（QQ 音乐）并支持多平台混合。若不引入「源」维度，两源共享同一原始 id 时会**互相覆盖**（收藏串源、队列定位错、缓存命中到错误音频）。
- 考虑过的方案：① 把源编码进 `id` 字符串（`qq:mid`）而不加字段；② 给实体加必填 `source` 字段 + 组合键助手 `keyOf`；③ 只加可选 `source` 字段。
- 决策：②。`MusicSource`（**现为 `'netease' | 'bilibili'`**，见 ADR-033）；`Track`/`Artist`/`Album`/`Playlist` 各加**必填** `source`；新增 `sourceOf(e)`（旧数据回填 `'netease'`）与 `keyOf(e) = \`${sourceOf(e)}:${e.id}\``；全仓所有「认曲 / 认实体」的比对一律改用 `keyOf`；`streamUrl(source, id)`与便捷式`streamUrlOf(track)`；后端抽 `SourceAdapter` 接口（`sources/{types,netease,qq,index}.ts`），路由 `/stream/:source/:id`、`/api/artist|album|playlist|lyric/:source/:id`，另**保留 2 段式别名**（视为缺省源，兼容 SW 外壳 7 天缓存下的旧页面）。
- 为什么选这个：`keyOf` 产物是普通字符串，可直接当 React key / Map key / Set 成员 / 缓存键前缀，**零结构改动**就让「收藏 / 最近 / 歌单成员 / 队列定位 / 缓存」跨源安全；必填 `source` 让所有产出点与构造点在 `tsc` 下**一次性报错、被迫处理**（尤其防止「QQ 曲目被当网易云解析」这类静默错误）；`SourceAdapter` 让「能力可缺」成为显式语义（缺失成员 → 路由回 501、前端隐藏入口），便于分阶段上线。
- 为什么不选其他：① 把源塞进 id 字符串会让 URL 不透明、且 `encodeURIComponent` 后不可读，且仍有「忘记加前缀」的漏网点；③ 可选字段无法在编译期拦截漏设 `source` 的产出点（正是最危险的错误）。
- 后果 / 已知边界：
  - 旧持久化数据（player localStorage 队列 / library IDB / 云同步 JSON 载荷）缺 `source`，一律经 `sourceOf` 读时回填 `'netease'`，**不做**破坏性回写。
  - 本地自建歌单 id 仍以 `pl-` 开头，与源命名（`netease`/`qq`）不冲突；`isMusicSource()` 守卫 `:source` 段，非法即 404（或对本地歌单而言视为 2 段式路由）。
  - **QQ 适配器的 `sign` 风险**见 ADR-024。
- 何时重新审视：接入第三个源时（`MusicSource` 扩展 + 注册表加一项即可）；或当某源需要「同一实体多源合并」（需 ISRC 级实体解析）时另立 ADR。

## ADR-023：云同步身份锚点仅网易——多源下**有意不动**

- 日期：2026-10-06
- 状态：已采纳 → **部分修订**（云同步锚点已由 **ADR-028** 改为跟随活动账号；本条的其余内容仍有效）
- 背景：ADR-016 的云同步按**网易云 `userId`** 把 library 存到 `.data/sync/<userId>.json`。接入 QQ 音乐后浮现一个选择：是否引入与源无关的首方身份（`profileId`），让「只绑 QQ、不绑网易云」的用户也能云同步。
- 决策：**保持仅网易锚点，不动**。`requireUserId` 只取访客本人网易云 cookie；未登录网易云即无云同步；前端「云同步」开关**仅当网易云已登录时出现**（头像菜单内分源展示登录态，主头像优先显示网易云，否则 QQ）。
- 为什么选这个：本项目的定位是「**免注册**即用」（PRD 非目标明确排除「多用户账号体系」）。引入首方 `profileId` 意味着自建账号/身份基建，作用域与风险都显著增大；而「一个浏览器同时持多源会话、跨源数据（混搭歌单）存本地 IDB」在无云同步时已完全可用。
- 为什么不选其他：现在就上首方账号系统（方案 B）违背既定非目标，属过度设计；用「任一源登录即当锚」会让「换源登录」悄然切换云端副本归属，语义危险。
- 后果 / 已知边界：**只绑 QQ 的用户没有云同步**（属有意取舍，非缺陷）；跨设备同步仍要求登录网易云。若日后确有「源无关身份」需求，另立 ADR 引入 `profileId`（本地生成、可被某一源登录认领）。
- 何时重新审视：当用户反馈「只想用 QQ 却要同步」成为高频诉求时。

## ADR-024：QQ 音乐接入方式——自研最小适配器（实测：全程无需 sign）

- 日期：2026-10-06
- 状态：~~已采纳~~ **已废弃**（QQ 音源已整体移除，见 ADR-033；本条保留作历史记录）
- 背景：需要第二个源，选 QQ 音乐（版权更全）。QQ 的流是**明文**（`ws.stream.qqmusic.qq.com/...mp3?vkey=`，`.mflac/.mgg` 加密仅针对客户端下载文件、不涉及串流），故非 DRM、可沿用 `/stream` 代理模型（区别于被否决的 Spotify——见 `docs/researches/spotify-multi-source.md`）。接入方式需在「自研最小适配器」与「依赖维护库/侧车进程」间定夺。
- 考虑过的方案：① 起一个 QQ API 服务进程，后端 HTTP 转调；② 引入第三方 QQ API npm 库；③ 自研最小适配器（`fetch` 直连若干端点）。
- 决策：③，且**全程无签名**（`platform:'h5'`）。经真实环境逐一实测：
  - **搜索** `musicu.fcg` 的 `SearchCgiService.DoSearchForQQMusicDesktop`（**无需 sign**），`search_type`：0 单曲 / 1 歌手 / 2 专辑 / **3 歌单**（歌单响应键为 `songlist`）。旧的 `c.y.qq.com/client_search_cp` 已被**阉割**（返回 `code:0` 但 `totalnum:0`）——这是「什么都搜不出来」的根因，弃用。
  - **取流** `vkey.GetVkeyServer`（**无需 sign**）；**不带 `filename`** —— 由 QQ 按内部 `media_mid` 返回正确文件。自拼 `M500<songmid>.mp3` 在 `songmid ≠ media_mid` 时会指向**不存在的文件（404→502）**（旧曲尤甚），这正是「歌单/专辑里的歌点了放不出」的根因。付费曲匿名空 purl → 需登录。
  - **专辑** `fcg_v8_album_info_cp.fcg`、**歌单** `fcg_ucc_getcdinfo_byids_cp.fcg`、**歌词** `fcg_query_lyric_new.fcg`（`nobase64=1`）——均无签名、实测可用（曲目为**老式键** `songmid/payplay`，搜索为**新式键** `mid/pay_play`，归一化兼容两者）。
  - **歌手详情**：`music.musichallSinger.SingerInfoInter.GetSingerDetail` **恒返回 104400**（无按-mid 取法），改用**按歌手名搜索**（演唱者页跳转携带 `?name=`，见路由 `artistDetail(id, cred, name)`）+ 按 mid 过滤；无名字时退化为最小档案。
  - **登录** QQ PT 扫码（`ptqrshow` → `ptqrlogin`，`hash33` 算 `ptqrtoken`），成功码映射为网易云 800/801/802/803 契约。
  - 另**保留**自研经典 `zzc` 签名 `qqSign` 及单测（当前请求**并不需要**，作为 h5 平台若被锁时的回退）。
    完整能力面：`searchSongs/Albums/Artists/Playlists`、`albumDetail`、`artistDetail`、`playlistTracks`、`songUrl`、`getLyric`、`qr*`。
- 为什么选这个：与既有 `netease.ts` 的「归一化 + https 改写 + Set-Cookie 收敛」三段式同构；零新进程，保持「单进程同源」；QQ 私有 API 无论用不用第三方都存在「上游一变即碎」的风险，自研至少可控可调。
- 为什么不选其他：① 引入第二个进程/端口/生命周期，违背 ADR-002「以函数形式调用，省掉一层进程与端口」的精神，部署变复杂；② 这类包多为薄封装且维护不稳，引入后仍要自己写归一化（`Track/Album/Artist` 是本项目专属形态），收益仅剩「签名」一处。
- 现状与已知边界（**已实测校准**）：
  - 搜索/专辑/歌单/歌词/免费曲取流**均可用**（实测：`searchSongs('汪峰')` 出《光明》等；`albumDetail` 14 首；`artistDetail` 56 首 + 31 专辑；`playlistTracks` 100 首；`getLyric` 48 行带时间轴；免费曲 `songUrl` 取流 200 `audio/mpeg`）。
  - **VIP 曲匿名取流为空** → `songUrl` 返回 null → 前端「暂不可播放 + 登录解锁」（复用既有机制）。
  - **QQ 登录扫码流程**已实现但**未在真实扫码下验证**（需人用 QQ 音乐 App 扫一次）；`QQ_COOKIE` 缺省凭证同理。
  - QQ 对匿名请求有频控；h5 `platform` 目前免签，若上游收紧需回退到 `qqSign`（已备）或换 `platform`。
- 何时重新审视：若 h5 平台被要求签名且 `qqSign` 失效，则改为**依赖带 sign 机器的维护库**；若 QQ 提供按-mid 的歌手接口，可去掉 `?name=` 依赖。

## ADR-025：音频缓存键加入源前缀；DB v3 丢弃旧音频缓存

- 日期：2026-10-06
- 状态：已采纳
- 背景：SW 音频缓存键原为 `${trackId}|${level}`，后端 urlCache 原为 `${id}|${level}|${cred}`。多源下两源可能共享同一原始 id，不带源会让源 A 的缓存被源 B 命中、**播放/下载到完全错误的音频**（正确性问题，非命中率问题）。
- 决策：前端 `mediaCache.audioKey(source, id, level)` → `` `${source}:${id}|${level}` ``（与 `keyOf` 同形）；后端 urlCache 键 → `` `${source}|${id}|${level}|${credKey}` ``（后端多一维凭证指纹，与前端**有意不同形**，见 ADR-012）。改动使旧键条目不再命中——升 `idb.ts` `DB_VERSION` 2→3，在 `onupgradeneeded` 中**删除并重建** `media` / `mediaMeta`（沿用 v1→v2 删 store 的先例；媒体缓存「可弃」）。**封面 `imageKey` 不加源**（键是完整规范化绝对 URL，跨源天然不冲突；且 SW 图片拦截路径拿不到 source）。
- 为什么选这个：全仓只有一套身份拼法（`: <source>:<id>`），SW / 后端 / 前端三处对照即懂；删 store 重建代码最少且封面本有 7 天 TTL 会自然刷新。
- 为什么不选其他：精细迁移（只清非新格式的 audio 条目、保留封面）代码多、收益小；封面加源在前端做不到（拿不到 source）。
- 后果 / 已知边界：升级后**音频与封面缓存清空一次**（重新下载，可接受）；`MediaMeta` 增 `source?` 为纯加性变更。
- 何时重新审视：若日后做音频分片缓存，键形需一并重估。

## ADR-026：搜索按源分组、提供二元源 tab、不跨源去重

- 日期：2026-10-06
- 状态：已采纳
- 背景：多源搜索需决定「如何整合」：一次返回全部源再合并排序，还是按选中源分别查询。
- 决策：`/api/search/all?source=` 按源查询（默认网易云，不默认双发）；前端在分类 tab **之上**加一行**源 tab**（网易云 / QQ 音乐），并把 `source` 写进 URL（`?q=&source=`）；**不跨源去重**（各源内部 id 唯一，`key={id}` 在该源内不冲突）。响应带 `capabilities` 标记各类目是否受支持（缺失视为支持），供前端隐藏不支持的分类。
- 为什么选这个：默认源是网易云 → **绝大多数搜索根本不触达 QQ**（QQ 频控敏感，这是不可恢复的风险，优于「每次搜索双发」）；单源失败隔离（该 tab 报错不影响另一 tab）；`useAsync` 的内存缓存让来回切 tab 第二次即瞬时。
- 为什么不选其他：一次返回两源分组会**放大频控暴露**且上游负载翻倍，与「默认网易云」的诉求相悖；跨源自动合并需要实体解析（ISRC 或 title+artist 模糊），有「把可播放源悄悄藏掉」的风险，且打分跨源不可比。
- 后果 / 已知边界：切到 QQ tab 首次有一次网络往返；不做「同曲多版本」聚合（待两源都提供 ISRC 后再议）。
- 何时重新审视：若引入提供 ISRC 的源，可考虑曲目级「版本聚合」。

## ADR-027：单活动账号模型——最多登录一个源，登录入口在登录后消失

- 日期：2026-10-06
- 状态：已采纳（**部分修订 ADR-023**，见 ADR-028）
- 背景：多源地基落地后，登录态是「每源一份」（`Record<MusicSource, LoginStatus>`），Topbar 分源列出登录/退出。用户提出：**第三方账号最多同时登录一个**；一旦登录，就不再需要登录入口。如此，「退出 / 云同步锚点 / 搜索默认源 / 首页·浏览的推荐」都只需跟随**那一个活动账号**，语义与实现都大幅简化。
- 考虑过的方案：① 维持多源并存，各自独立；② 单活动账号（登一个后无登录入口，只有退出）；③ 单活动账号 + 自动替换（登新源时自动登出旧的）。
- 决策：②。前端新增 `activeSource(status)`（遍历 `MUSIC_SOURCES` 取第一个 `logged`，无则 `null`）；`Topbar` **仅当未登录**才渲染「登录」按钮，登录后菜单只留「退出登录」（登 `activeSource`）与云同步开关——去掉分源登录/退出行。后端双保险：`/api/auth/:source/qr/check` 在 803 成功时，对**其它**已注册源下发其 `logoutCookieNames` 的过期 `Set-Cookie`，清掉可能的陈旧会话。
- 为什么选这个：UI 层面「登录后无入口」天然保证最多一个，无需处理"登第二个该怎么办"的分支；活动源唯一，后续三项（退出/同步/搜索·推荐）只需读 `activeSource`，不必再为每个源分别决策。用户明确选择此形态（而非自动替换）。
- 为什么不选其他：① 需要为"两个都登录时"定义显示、退出、同步归属等一堆规则，复杂且易歧义；③ 自动替换会在用户不知情时登出旧账号，逆用户预期。
- 后果 / 已知边界：
  - 想换账号必须**先退出**再登录。
  - 「播放受限提示」条里对**非活动源**曲目的"登录解锁"按钮仍会打开登录弹窗（切换账号的通道），后端清它源 cookie 保证切换干净。
  - `PlayErrorToast` 的源引导语义不变。
- 何时重新审视：若日后要支持"同时挂多个账号"，本决定与 ADR-028 需一并重估。

## ADR-028：云同步锚点跟随活动账号（`<source>:<accountId>`，修订 ADR-023）

- 日期：2026-10-06
- 状态：已采纳（**修订 ADR-023**）
- 背景：ADR-023 为守住"免注册"，把云同步锚点**固定为网易云 `userId`**。但单活动账号模型（ADR-027）下，"只登 QQ"是常态，固定网易锚点会让这些用户完全没有云同步。
- 考虑过的方案：① 保持仅网易（ADR-023 原样）；② 锚点改为 `<source>:<accountId>`（网易云 `userId` / QQ `uin`），随活动账号走。
- 决策：②。后端 `requireUserId` → **`requireIdentity(c): { source, id } | null`**（遍历源取已登录者的 `userId`）；云同步文件键 = **`<source>-<id>`**（`syncStore.sanitizeId` 已允许 `-`）。前端 `store/sync` 由 `userId?: number` 改为 `{ source?, accountId? }`，`enable(source, accountId)`；`useLibrarySync` 激活条件 = `enabled && activeSource===boundSource && 当前 id===boundId`。**`LoginStatus.userId` 由 `number` 改 `string`**（QQ `uin` 超出 JS 安全整数）。
- 为什么选这个：单活动账号下锚点天然唯一，`<源>:<id>` 是最小改动即可让"登谁就同步谁"；`loginStatus` 已能取到各源账号 id（QQ 侧补 `userId = uin`）。
- 为什么不选其他：① 让 QQ 用户无法云同步，与用户明确诉求相悖。
- 后果 / 已知边界：
  - 云同步归属随活动账号；换账号自动失活（绑定不符），不为新账号悄然开启——与 ADR-016 的失活语义一致。
  - 数据文件从 `sync/<neteaseUserId>.json` 变为 `sync/<source>-<id>.json`：**旧网易云云端副本需按新键名迁移**（旧部署需手工改名，或接受一次性的"云端无数据→以本地覆盖"）。
  - 已实测：`/api/discover/capabilities` 返回 `qq:{recommend:true,playlists:true,toplists:false}`。
- 何时重新审视：若引入源无关的首方 `profileId`（研究文档方案 C），锚点应再升级为该 id。

## ADR-029：QQ 音乐也提供「发现」（免登录歌单；无排行榜）

- 日期：2026-10-06
- 状态：~~已采纳~~ **已废弃**（QQ 音源已整体移除，见 ADR-033）
- 背景：ADR-027 后搜索/推荐都跟随活动源，故 QQ 也需提供首页「为你推荐」与浏览页各分区，否则登 QQ 后这些区域空白。
- 决策：`SourceAdapter` 新增**可选能力** `recommendPlaylists / toplists / topPlaylists`；`/api/discover/*` 加 `?source=`，并新增 `/api/discover/capabilities?source=` 返回 `{recommend, playlists, toplists}` 供前端隐藏不支持的 tab。QQ 侧用免签接口 `c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg`（歌单列表；`sortId` 区分排序）：`recommendPlaylists`（sortId=5，**以热门歌单近似个性化推荐**，QQ 的个性化推荐需登录/上下文）、`topPlaylists`（sortId=2）。
- 为什么选这个：该接口免签、实测可用、结构与 `normalizeQqPlaylist` 吻合；`capabilities` 让"某源缺某分区"成为显式语义而非 500/空。
- 为什么不选其他：QQ 的 `musicu.fcg` 个性化推荐模块全部 `500003`（模块名/参数未探得）且多需登录，不值得为免登录场景硬啃。
- 后果 / 已知边界：
  - **QQ 无「排行榜」**（`fcg_v8_toplist_opt.fcg` 及各类 `ToplistInfoServer` 模块均不可用）→ `toplists` 不实现，前端经 `capabilities` **隐藏该 tab**；`Radio` 无排行榜的源**退回热门歌单**。
  - QQ 的「为你推荐」实为「热门歌单」，非个性化——不在 UI 标注"个性化"。
- 何时重新审视：若探得 QQ 免登录的排行榜/个性化端点，可补上 `toplists` 并从 capabilities 放行。

## ADR-030：按活动平台展示——`Plan N/T` 标签、QQ 绿色主题、QQ 昵称与头像来源

- 日期：2026-10-06
- 状态：~~已采纳~~ **已废弃**（QQ 源与其主题色 / `Plan T` 随 ADR-033 移除）
- 背景：单活动账号（ADR-027）下，头像菜单原固定显示「Pterosaur+」，看不出当前用的是哪个平台；主题强调色固定为 Apple Music 红；QQ 登录后**昵称为空**（显示成 `QQ <号>`）、**头像不显示**。
- 决策：
  1. **计划标签**：该位置按活动源显示 **`Plan N`**（网易云）/ **`Plan T`**（QQ）——N=NetEase、T=Tencent。
  2. **主题色**：活动源为 QQ 时给 `<html>` 打 `data-source="qq"`（`hooks/useSourceTheme.ts`），`tokens.css` 的 `:root[data-source='qq']` 把 `--accent*` 覆盖为 **QQ 绿 `#31c27c`**；其它情况回到默认红。
  3. **QQ 昵称**：来自 **PT 登录回调** `ptuiCB(...,'<nick>')` 的第 6 参（`qrCheck` 捕获），随会话以 `qq_nick` cookie 携带（`encodeURIComponent` 编码），`loginStatus` 读取解码；缺失退化 `QQ <号>`。
  4. **QQ 头像**：**按 QQ 号直接拼** `https://q1.qlogo.cn/g?b=qq&nk=<uin>&s=100`（免鉴权，实测 200）。
- 为什么选这个：QQ **无免登录的资料查询接口**（实测 `music.UnifiedHomepage.UnifiedHomepageSrv.GetHomepageHeader` 等一律返回空 `BaseInfo`，无论是否带 `HostUin`/`authst`），故昵称取登录回调、头像用 QQ 号模板——两者都**确定性可用**、零额外上游调用。
- 为什么不选其他：继续调 `GetHomepageHeader` 每次状态查询都多一次徒劳的上游请求，且对匿名/无 musickey 的会话根本不返回内容。
- 后果 / 已知边界：
  - `qq_nick` 是**会话 cookie**（非敏感展示名），与 `uin`/`qm_keyst` 同批下发、退出时一并清理；昵称含中文时经 URL 编码，cookie 值保持 ASCII。
  - `Plan T`/绿色主题仅表示"当前活动源是 QQ"，**不代表真会员**；原 `vip` 字段仍随 `LoginStatus` 返回，供后续使用。
  - QQ 头像始终是**QQ 号头像**（非 QQ 音乐资料图）。
- 何时重新审视：若 QQ 开放免登录资料接口，可改取官方昵称/头像。

## ADR-031：音质档位（统一抽象档）与画质分档（大图基准 + 前端降档）

- 日期：2026-10-06
- 状态：已采纳（QQ 按档取流的 `filename` 拼接式标记为**待联网校准**；**部分修订**：设置「音质」已由 5 档收敛为两档，见 ADR-041）
- 背景：两个音源此前都「能播就行」——网易云 `song_url_v1` 恒取 `exhigh`（前端**从不传 `level`**），QQ `songUrl` 干脆忽略 `level`；封面/头像尺寸在后端**写死**（网易云 `?param=600y600`、QQ 仅 `T002R300x300`）。既没有可选音质，也没有画质概念：大屏拿小图、小图又可能拉大图。
- 考虑过的方案：
  - 音质组织：① 每源分别设置；② 单一「音质优先」开关；③ **统一抽象档位**（一个下拉，各源映射到最接近且可得的档）。→ ③。
  - QQ 取流：A 恒取默认档（现状）；B **按档构造 `filename` 取流**（保留「不带 filename」兜底）。→ B。
  - 档位不可得：X 严格不降级；Y **自动逐级降级**。→ Y。
  - 画质：I 用户可选尺寸；II **固定两档、按场景自动选**（小图 300 / 大图 1200）。→ II。
- 决策：
  1. **档位模型**（`packages/shared/src/types.ts`）：`AUDIO_LEVELS = standard | higher | exhigh | lossless | hires`（沿用网易云 `level` 取值，网易云侧**零映射**），`DEFAULT_AUDIO_LEVEL='exhigh'`，`AUDIO_LEVEL_RANK` 供降级排序，`audioLevelOrDefault` 兜底非法输入。`streamUrl/streamUrlOf` 的 `opts.level` 类型收紧为 `AudioLevel`；`mediaCache.DEFAULT_LEVEL` 改为 re-export 自 shared（消除双份默认值）。
  2. **传递链**：新增 `apps/web/src/store/settings.ts`（`persist`，`pterosaur-settings`）存 `level`；设置弹窗「音质」区块置于**最顶部**。`useAudioEngine` 订阅 `level` → `audioSrc(current, level)`，**换档保留播放位置**（复用弱网恢复的 `recoveringRef` 豁免：`load()` 后 `seekBack` + 续播）；下载链路（`download.ts` / `downloadPlaylist.ts` / `rip.ts`）同样带当前档。后端 `/stream/:source/:id?level=` **早已读该参数、缓存键含 level**，无需改动。
  3. **网易云**：`level` 直接透传 `song_url_v1`，上游自身按可得档降级。
  4. **QQ**：抽象档 → 复合档**候选链**（`M500` 128k / `M800` 320k / `F000` FLAC / `Q000` 臻品；`higher` 无真 192k 落 `exhigh` 链），**一次 `CgiGetVkey` 并发多档**（`songmid`/`filename`/`songtype` 按下标一一对应），取首个 `purl` 非空者——即「≤ 目标档的最高可得档」，天然降级；`media_mid` 取自 `music.trackInfo.UniformRuleCtrl`，进程内 LRU/TTL 缓存；候选全落空则回退**不带 `filename`** 的旧路径，保证零回归。
  5. **画质两档**：`packages/shared/src/image.ts` 新增 `COVER_SMALL=300` / `COVER_LARGE=1200` 与 `coverAt(url, px)`（网易云设 `param`；QQ 替换 `T00?R{W}x{H}M000` 尺寸段；其它 CDN 原样）。后端**统一产出大图基准**（网易云 `1200y1200`、QQ `R1200x1200`），前端按场景 `coverAt` 降档——小图（`TrackList`/`QueuePanel`/`Home`/`Sidebar`/`PlayerBar`/`Topbar`/`EntityCards`/`PlaylistCard`）用 300；大图（`NowPlaying` 封面与背景、`Album`/`Artist`/`Playlist` hero）用 1200；**翻录封面另设 `COVER_RIP=3000`**（2026-10-07 增补：实测网易云图片母带上限即 3000，`param` 请求再大也只回 3000×3000、不上采样——「尽可能大」取 3000 足矣）。`useNowPlayingPrefetch` 与 `NowPlaying` **必须同档**（1200）以保首帧显色门控。
- 为什么选这个：档名与网易云一致 → 网易云零映射；抽象档 + 逐级降级让跨源体验一致，且不因高档不可得而断播；画质「大图基准 + 前端降档」把 CDN 细节收口在 `shared/image`，缓存键**天然即 URL**、无需改 SW/IDB（旧封面条目靠 7 天 TTL 自然回收，**无需 DB bump**）。
- 为什么不选其他：分源设置让设置项翻倍且两源命名不统一；严格不降级会在未登录 / 无无损时频繁断播；画质做用户可选属过度设计；QQ 若恒取默认档则 `lossless` 等形同虚设。
- 后果 / 已知边界：
  - **QQ `filename` 拼接式**（`prefix+media_mid+ext` 与社区变体）与**高档通道**（母带/臻品是否在 Web/H5 可得）**待联网校准**；取流失败自动回退默认档，不阻塞播放。要求首次上线在有网环境用真实响应校准。
  - **QQ 歌单封面**（`normalizeQqPlaylist`）仍返回上游原始 URL、不经尺寸规范化，`coverAt` 对其原样返回（不匹配 QQ 图模板）。
  - 画质两档使同图 300 与 1200 各占一条封面缓存，**条目与流量翻倍**（预期代价）；小图由原 600 降为 300，列表缩略图略降。
  - 换档会触发整段重新拉流（SW 未命中新档键）；`higher` 在 QQ 落 `exhigh` 链。
- 何时重新审视：QQ 若强制 `musics.fcg` 的 `sign`+AES-GCM（ADR-024 已留回退路径），或提供稳定的按档 `filename` 契约；若引入音频分片缓存（ADR-012），换档续播可免整段重拉；若未来要画质用户可选，再评估引入第三档。

## ADR-032：接入咪咕音乐（第三音源）——无登录源的登录能力可选化、主题随「当前源」、封面不降档

- 日期：2026-10-06
- 状态：~~已采纳~~ **已废弃**（咪咕音源已整体移除，见 ADR-033；「扫码能力可选」的设计保留在 `SourceAdapter` 中）
- 背景：多源地基（ADR-022）落地后接入第三源**咪咕音乐**。实测确认咪咕音频是 `freetyst.nf.migu.cn` 上的**明文 MP3/FLAC**（带 Range、完整曲长），与 QQ 同构、**无 DRM**，可沿用既有 `/stream` 明文代理（详见 `docs/researches/migu-source.md`）。但咪咕有两点与既有源不同：(1) **无扫码登录**（其登录是手机号/短信），而 `SourceAdapter` 原把 `qrKey/qrCreate/qrCheck` 设为**必选**、没有「不支持登录」的表达；(2) 主题色原由**活动账号**驱动（ADR-030），而无登录的咪咕永远不会成为活动账号 → 洋红主题无处触发。
- 考虑过的方案：
  - 登录：① 一并实现短信登录；② **不实现登录，把扫码能力改为可选**。
  - 主题驱动：③ 维持只看活动账号（咪咕主题永不触发）；④ **改由「当前所处源」驱动**（路由显式带源时以路由为准，否则跟随活动账号）。
  - 封面：⑤ 新增 `coverAt` 的咪咕分支；⑥ **取大图一档、不降档**。
- 决策：
  1. **登录可选化**：`SourceAdapter` 的 `qrKey/qrCreate/qrCheck` 改为**可选**；`app.ts` 的 `/api/auth/:source/qr` 与 `/qr/check` 对缺失者回 **501**；`/api/auth/:source/status` 响应新增 `loginable`（= 是否有 `qrKey`），落到 `LoginStatus.loginable?`。前端 `LoginModal` 只列 `loginable` 的源、`PlayErrorToast` 对 `loginable===false` 不显示「登录解锁」。
  2. **咪咕适配器**（`server/sources/migu.ts`）：搜索（歌曲/专辑/歌手/歌单）、专辑/歌手/歌单详情、批量曲目、取流（`toneFlag` 候选链逐级降级）、歌词（`lrcUrl` 明文）、发现（推荐歌单 + 排行榜）；`sessionCookieNames`/`logoutCookieNames` 均为空。**排行榜 id 加 `rank:` 前缀**，`playlistTracks` 据此分派到 `rank-info`。
  3. **主题随当前源**：`useSourceTheme` 由「只看活动账号」改为「路由显式带源优先（`/playlist|artist|album/:source`、`/search?source=`），否则活动账号，未登录回落缺省源」；`<html data-source="migu">` 触发 `tokens.css` 的洋红 `--accent` 系列；`Topbar` 的 `Plan` 标签加 `migu→M`。
  4. **缺省凭证**：`defaultCredential` 由二元改映射 `{netease:NETEASE_COOKIE, qq:QQ_COOKIE, migu:MIGU_COOKIE}`。
  5. **封面取大图一档**（`imgSizeType='03'`，800²），`coverAt` 对咪咕 URL 原样返回。
- 为什么选这个：②把「不支持登录」变成**一等能力**（对齐 `SourceAdapter` 既有的「能力可缺」哲学），既最小又通用；④让主题反映**你在看哪个平台**，是唯一能让无登录源拿到自身主题色的方式；⑥因三档封面是**三个不同文件**（不同 hash），改写尺寸段不可行，取大图是无额外结构的正确做法。
- 为什么不选其他：①短信登录是独立大功能（发码/校验/会话保持 + 非扫码 UI），应单独立项；③会让咪咕主题永不出现、用户诉求落空；⑤技术不可行（三档无参数化关系）。
- 后果 / 已知边界：
  - **第三音源扩展点**：`MusicSource` 加 `'migu'`；`MUSIC_SOURCES` 顺序 `['netease','qq','migu']`；注册表加 `migu`。级联到各 `Record<MusicSource,…>`。
  - 新增 `MIGU_COOKIE` 环境变量；`pnpm log-in --source=migu` 明确报错（无扫码）。
  - 主题：实体路由 / 搜索带源时**即使已登录其它源也按路由源**着色（ADR-030 的**部分修订**）。
  - **封面不降档**：列表缩略图拉大图（相对 ADR-031 偏差）；`d.musicapp.migu.cn` 稳定故不做 URL 规范化。
  - 咪咕对匿名请求有**频控**；VIP 曲匿名不可播（`needLogin`）。
- 何时重新审视：若实现短信登录（应去除 `loginable` 隐藏、把咪咕纳入单活动账号）；若咪咕封面提供尺寸参数（可恢复 `coverAt` 降档）；若 `MIGU_COOKIE` 路径实测失败（调整 `copyrightId` 传递）。

## ADR-033：移除 QQ / 咪咕音源；新增「MV」渠道（B 站，只放音频）

- 日期：2026-10-06
- 状态：已采纳（**废止** ADR-024 / ADR-029 / ADR-030 / ADR-032；**部分修订** ADR-022 / ADR-026 / ADR-031）
- 背景：实测 QQ 音乐与咪咕音乐的可用性 / 稳定性明显不足（QQ 频控 + 私有 API 易碎、咪咕曲库与体验有限），维护成本高于收益。同时制作人希望搜索时能一并搜到 B 站视频、并**只解析其音频**播放（B 站为 DASH 音视频分轨，取 `dash.audio` 即可，无需解析视频）。
- 考虑过的方案：
  - 源收敛：① 保留三源；② **移除 QQ / 咪咕，仅留网易云**。
  - MV 定位：③ 把 B 站做成与网易云并列的**可浏览音源**；④ **做成独立「MV 渠道」**，只出现在搜索页的分类 tab 里（「歌曲」右侧）。
- 决策：
  1. **移除 QQ / 咪咕**：删适配器、注册表项、`MusicSource` 分支、主题色块（`tokens.css` 的 `[data-source='qq'|'migu']`）、CLI 分支、`QQ_COOKIE`/`MIGU_COOKIE` 及各自单测；相关 ADR 标注废弃。
  2. **源清单双名单**（`packages/shared/src/types.ts`）：`MUSIC_SOURCES = ['netease']`（可浏览 / 发现）、`MV_SOURCES = ['bilibili']`（MV 渠道）、`ALL_SOURCES = [...MUSIC_SOURCES, ...MV_SOURCES]` 且 `MusicSource = (typeof ALL_SOURCES)[number]`。**B 站是一等账号**：`activeSource`（顶栏账户菜单 / 云同步锚点）、`/api/auth/*` 的「单活动账号」清理、后端 `requireIdentity`（云同步身份）**都遍历 `ALL_SOURCES`**；而「可浏览内容」的页面（首页 / 浏览 / 电台 / 搜索默认源 / 源主题）改用 **`activeMusicSource`**（仅 `MUSIC_SOURCES`），以免这些需要发现 / 歌单 / 排行榜能力的页面被 B 站带偏。
  3. **B 站适配器**（`apps/server/src/sources/bilibili.ts`）：搜索走 `x/web-interface/search/all/v2`（**实测未被风控**；`x/web-interface/wbi/search/type` 会回 `v_voucher` 人机验证）；取音频 `x/player/pagelist → x/player/playurl(fnval=16) → dash.audio`，按抽象档挑最接近的码率；`streamHeaders` 带上 `Referer`（必需，否则 403）；扫码登录走 `passport-login/web/qrcode/{generate,poll}`（**URL 即 key**，无状态）。`sessionCookieNames = logoutCookieNames` 覆盖 `SESSDATA/bili_jct/DedeUserID/buvid3/bili_ticket`。
  4. **前端 MV tab**：搜索页分类行「歌曲」右侧加「MV」，**与音乐结果并行取数**（不惰性加载）；源 tab 行移除（只剩一个音乐源，无需切换器）。
  5. **音频响应 Content-Type 依直链后缀回写**（`app.ts` 的 `audioContentTypeFromUrl`）：网易云 CDN 对 `.flac` 谎报 `audio/mpeg`、B 站 m4s 为 `application/octet-stream`——按 URL 后缀纠正后，下载能落正确后缀、SW 也能按 `audio/*` 入缓存。
  6. **分P 一对多**：B 站分P 视频入队时展开为多项——新增 `/api/parts/:source/:id`（适配器可选能力 `parts`），每分P 一项、`id` 为 `<bvid>:<cid>`（`songUrl` 据此直接定位，无需再查 cid）。**MV tab 点一个 → 队列 = 该视频的分P**；其它列表（含歌单）点击 → 队列 = 该列表、其中 B 站条目**就地展开**。展开出的都是普通 `Track`，可与歌曲混排 / 收藏 / 排序。
  7. **封面防盗链**：B 站图床对**异域 `Referer` 返回 403**（无 Referer 才 200），故封面 `<img>` 与 SW 图片回源均带 `referrerPolicy: 'no-referrer'`。
  8. **匿名解析重试**：B 站匿名接口偶发抽风。适配器请求层（`bGet`）**只要任何一次请求失败就重试**——网络错误 / 非 2xx / 上游 `code !== 0` **与具体错误码无关**——按固定 **333ms** 间隔连试 5 次，覆盖搜索 / `view` / `pagelist` / `playurl` / `nav` 全部解析调用，以免把「播放出错，请检查网络后重试」这类失败透给用户。网易云解析原有实现无重试，保持不动；**前端**播放重试则所有音源**统一**沿用网易云的退避模式（见 ADR-021）。
  9. **登录 cookie 必须保持原始百分号编码**：B 站 `SESSDATA` 自身含 `%2C`，若从回跳 URL 用 `searchParams.get` 取值会被**解码成逗号** → 写出非法 cookie（RFC 6265 的 cookie-value 不允许逗号，浏览器拒存）或错误值 → 表现为**「登录成功但一刷新登录就掉」**。故 `collectLoginCookies` 改走 `rawQueryValue`（按 `&`/`=` 原始切分、**不解码**），并优先用 poll 的 `Set-Cookie`、缺失才从 URL 补齐（同名不重复）。
- 为什么选这个：②移除低价值源可显著减少维护面；④把 B 站做成独立渠道而非可浏览源，避免其（无专辑 / 歌单 / 排行榜）污染既有页面的能力假设；⑤在服务端一处收口，同时修好「无损下载后缀错为 .mp3」与「B 站音频不入 SW 缓存」两个问题。
- 为什么不选其他：①保留三源需持续跟进 QQ / 咪咕的私有 API 与频控，收益为负；③会让 B 站出现在首页 / 浏览的源切换里，但那些页面需要的能力它一概不具备。
- 后果 / 已知边界：
  - `keyOf` / 缓存键 / `/stream/:source/:id` 等**多源地基原样保留**（`bilibili` 即第三种 `source`），未来接新源仍只需注册一个适配器。
  - B 站**匿名**即可拿 `dash.audio`（实测最高 ~204kbps）；带 SESSDATA（扫码登录或 `BILIBILI_COOKIE`）可提升码率与稳定性。
  - B 站搜索与音频直链来自**非官方接口**，上游一变即需适配；搜索端点存在**风控**可能（换 IP 触发人机验证）。
  - B 站登录态**不进入**单活动账号 / 云同步身份（独立于音乐源）。
  - 旧的 `qq` / `migu` 持久化数据（收藏 / 最近 / 队列）在 UI 上不再可达；`keyOf` 仍能解析，不崩溃。
- 何时重新审视：若 B 站接口风控收紧到不可用；若需要「B 站登录并入单活动账号」；若重新引入其它音乐源。

## ADR-034：登录 / 退出登录时清空全部缓存

- 日期：2026-10-06
- 状态：已采纳
- 背景：媒体缓存**不带登录身份维度**——前端 SW 的音频键是 `source:id|level`（ADR-025）；后端 URL 缓存虽带凭证指纹，但前端那一层会跨凭证复用。于是「匿名时缓存的 30 秒试听」在登录之后仍被播放（反之亦然），表现为「登录 / 退出登录后播放没有变化」。App 外壳（Cache Storage）与若干内存缓存（歌词 / 封面就绪登记 / `useAsync` 取数）同样跨凭证复用旧结果。
- 考虑过的方案：① 把凭证指纹并入 SW 音频缓存键；② **在凭证变化（登入 / 登出）时清空全部缓存**。
- 决策：②。新增 `apps/web/src/lib/clearCaches.ts` 的 `clearAllAppCaches()`：清 IDB 媒体池（音频 + 封面）+ 通知 SW 清内存元数据索引 + 清 Cache Storage（外壳 / 图标）+ 清内存缓存（`clearLyricCache` / `clearCoverRegistry` / 新增 `clearAsyncCache`）。在 `store/auth.ts` 的 `finishQrLogin`（登录成功）与 `logout`（退出）各调用一次。**不动**资料库（收藏 / 歌单）与登录态本身。
- 为什么选这个：清缓存是「凭证变化」这一低频事件的合理代价，且一处收口、无需改缓存键形或 DB 版本；同时覆盖「匿名缓存被登录后复用」与「登录缓存被登出后复用」两个方向。
- 为什么不选其他：① SW 侧拿不到可靠的凭证状态（session cookie 可能 httpOnly、SW 也无法读 document.cookie），键里加什么都会漂移；且会 bump DB 版本、清空一次既有缓存。
- 后果 / 已知边界：
  - 登入 / 登出会**重新下载应用外壳**（Cache Storage 被清），下次导航多一次网络往返；若想保留外壳缓存，可去掉 `clearCacheStorage()` 只清媒体池。
  - 清媒体池为异步且可能较慢（大量 IDB 删除），但发生在登录 / 退出这类低频操作上，可接受。
  - **不改动**资料库（IDB 的 favorites / recent / playlists）与云同步数据。
- 何时重新审视：若未来把凭证指纹纳入 SW 缓存键（缓存键本身能区分身份），本清空可降级为「仅登出时清」或取消。

## ADR-035：B 站字幕作为 MV 渠道歌词（登录可见 + 主语言/中文双语）

- 日期：2026-10-07
- 状态：已采纳
- 背景：MV 渠道（ADR-033）此前 `getLyric` 恒空（前端「暂无歌词」）。B 站视频自带 CC 字幕（UP 上传 + AI 生成）：`x/player/wbi/v2` 返回轨列表（`subtitle.subtitles[]`：`lan` / `is_lock` / `ai_type` / `subtitle_url`），`subtitle_url` 指向的 JSON 正文（`body[]`：`from`/`to`/`content`）天然是带时间轴的「歌词」。但**字幕列表要求登录**：匿名（无 SESSDATA）请求 `subtitles` 恒为空——wbi 签名也救不了（2026-10 实测），与网页端未登录看不到 CC 一致。需求：主语言非中文时引入多语言、且必含中文。
- 决策：适配器实现 `getLyric`，全链路失败一律降级空歌词（前端「暂无歌词」），不打挂播放链路：
  1. **通道**：`id` 解析（`<bvid>` 取首P / `<bvid>:<cid>` 分P 定位，与 `songUrl` 同规）→ **wbi 签名**的 `player/wbi/v2` 取轨列表（密钥取自 `nav.wbi_img`，盐表混淆成 32 位 mixinKey，进程内缓存 24h；签名失败回落非签名 `player/v2` 一次）→ 拉 `subtitle_url` JSON（`//` 补 https，主/中两轨并行）→ 构建共享 `Lyric`。
  2. **语言策略——双语模式**（`pickSubtitleTracks`，对齐 B 站播放器「原文在上、中文在下」的双语字幕）：**原文轨优先**：主轨 = 首条**非中文人工轨** → 锁定轨 → 列表首条；主轨**已是中文** → 单语直接用（华语视频 / 仅 `ai-zh` 的外语视频皆然）；主轨非中文 → **中文轨作 `translation`**（复用网易云「原文 + 译文」模型与 `LyricLine.translation` 单译文槽，**前端零改动**）；中文轨**人工 CC 优先、AI 字幕兜底**；完全无中文轨则尽力而为只出主语言；无 `subtitle_url` 的轨不参与（未登录时 AI 轨常无地址）。
  3. **时间对齐**（`buildLyricFromSubtitles`）：两轨常出自不同作者、**分段不一致**（实测乔布斯演讲：en 原文 395 行 vs zh 意译 186 行），不能像 `parseLrc` 那样按时间相等（±0.01s）配对，改为**最大重叠挂载**：每条中文行挂到与其重叠时长最大的原文行（并列取更早；多条中文挂同一原文行按时间序空格连接；落在原文间隙的丢弃）。两轨分段一致（同作者逐句对照）时自然退化为逐行精确配对，无需特判。
  4. **实证采样（2026-10，登录态）**：① 轨列表字段 `type`：**0 = 人工 CC、1 = AI**（与 `ai_type` 冗余，判 AI 取任一命中或 `ai-` 前缀语言码）；② `is_lock` 现代数据几乎恒 false，不再是可靠的「默认轨」信号；③ 人工中文译轨常排在原文轨**之前**（乔布斯演讲 `[zh, en, ai-zh]`），按列表顺序取首条会把译文当主语言——原文轨优先即为此设；④ `asr_language`（原以为的原声语言权威信号）实测恒空，弃用；⑤ `subtitle_url_v2`（`subtitle.bilibili.com` 混淆地址）对非浏览器客户端 TLS 直接拒连，弃用，老地址带 `auth_key` 时效签名、现拉现用；⑥ AI 对外语视频只产出 `ai-zh` 翻译轨（无原文识别轨），此时无从双语、中文单语；AI 正文 JSON 多 `sid`/`music` 等字段，解析时忽略。
- 为什么选这个：`LyricLine` 本就 text + 单译文槽，主轨 + 中文恰好两个语言槽，不扩数据模型、前端零改动；「原文 + 译文」与网易云心智一致。
- 后果 / 已知边界：
  - **未登录看不到字幕**是 B 站上游限制（非本系统 bug）；浏览器内扫码登录 B 站，或服务端配 `BILIBILI_COOKIE`（`pnpm log-in:bilibili` 写入，`login.ts` 已参数化支持 `netease|bilibili`）均可解锁；登录/退出会清空歌词缓存（ADR-034），凭证切换不残留旧结果。
  - AI 字幕（`ai-zh` 等）仅登录后可见且地址带签名 token，拉取时同样带 cookie。
  - 超过两门语言（如 en + ja + zh 同存）只引入主轨 + 中文两门，其余不展示。
  - 字幕点击可跳转（`timed: true`，`time = from`），空正文行已过滤、多行空白折叠为单行。

## ADR-036：`shuffle` 改为「不重复的排列游走」——手动切歌与自然推进一致

- 日期：2026-10-07
- 状态：已采纳（**修订** `docs/specs/module-player-state.md` 的「shuffle 下 next：随机跳转」一条）
- 背景：开启 shuffle 时，队列**已**由 `shuffledIndexes` 一次性 Fisher–Yates 重排（`toggleShuffle` / `cyclePlayMode` / `playTracks`），自然结束推进 `advanceOnEnd` 在 `repeat='all'` 下已是 `index+1` 顺序游走。但 **`next()`/`prev()` 的 shuffle 分支各自 `Math.floor(Math.random()*len)` 跳转**：与自然推进不一致、可能连播同一首 / 漏播、且「下一首」不可预测——使前瞻预载（ADR-037）无从下手。
- 考虑过的方案：① 保留每次随机跳转（现状）；② 每次 `next` 重洗剩余队列；③ 删除 `Math.random`，队列一次性重排后**顺序游走**。
- 决策：采纳 ③。`next()` → `index+1`（越界：`repeat='all'` 回绕 0，否则停止并置 `playbackEnded`）；`prev()` → `index−1`（越界回绕 `len−1`，保留「已播 >3s 先回开头」）。`shuffledIndexes` 保留，`shuffle` 标志此后**仅决定队列是否被重排**。
- 为什么选这个：与 `advanceOnEnd` 逐首一致，手动 ± 与自然推进统一；一次洗牌保证「整列不重复走一遍」；顺序确定，预载可预测。
- 为什么不选其他：① 随机跳转语义下无「上一首」概念、易重复，且不可预载；② 每次重洗剩余队列会让「上一首」回溯无意义、且不断消耗随机。
- 后果 / 已知边界：`shuffle + repeat='one'`（仅 `toggleShuffle` 单独调用可出现）队尾 `next` 会**停止**——与 `repeat='off'` 一致；`baseQueue`↔`queue` 关系不变；`toggleShuffle` 仍不改 `repeat`（既有行为，本次未动）。
- 何时重新审视：若引入真实播放历史栈、或需要可复现的洗牌种子（分享「随机歌单」）。

## ADR-037：队列前瞻 / 回瞻预载（前后各 2 首，SW 自取）

- 日期：2026-10-07
- 状态：已采纳
- 背景：此前仅预载**当前曲**的封面（`COVER_LARGE`）+ 歌词（`useNowPlayingPrefetch`），音频只在首次播放时被 SW 整曲落盘。切歌 / 跳到下一首 / 回到上一首仍要等一次网络起播，封面可能闪一下。目标：在网络良好且播放侧空闲时，预热队列相邻曲目的音频 / 封面 / 歌词。
- 考虑过的方案：
  - 音频落法：**A** 页面 `fetch` 排空 body（字节穿过页面）/ **B** 新增 SW 消息由 SW 自取并写缓存。
  - 封面档位：只 `COVER_LARGE` / 只 `COVER_SMALL` / **两档都预**。
- 决策：**B + 两档封面 + 前后各 2 首**。协议抽为纯模块 `lib/prefetchProtocol.ts`（`PREFETCH_AUDIO`：页面构造 / SW 校验）。门控：`navigator.onLine` + Network Information API（`saveData !== true`；`effectiveType` 允许 `4g` 或未知，跳过 `slow-2g/2g/3g`）+ `!buffering` + 当前曲 `readyState ≥ 3`；经 `requestIdleCallback`（退化 `setTimeout`）**串行**执行，`settle 2500ms` 防抖、曲间 `gap 1500ms`。封面 `preloadCover`（`<img>` → SW `handleImage` 落同一 IDB 池）；歌词 `prefetchLyric`（内存）。
- 为什么选这个：
  - **B** 复用 SW 的 `storeResponse` / LRU / 单飞，页面零字节处理、零缓存逻辑重复；**关键前提**：SW 自身发起的 `fetch()` 不被其自身 fetch 处理器拦截，故 SW 内 `fetch('/stream/...')` 直连后端、不递归。
  - 预载路径**绝不** `notifyNeedLogin`——预热的是「还没打算播」的曲目，为其弹登录框会打扰用户；403 / 非音频 / 非整段一律静默丢弃。
  - 两档封面各自是**独立缓存条目**（key 含 `param`），列表行与沉浸页均需瞬显，故都预。
  - 快速连跳由 `settle` 抑制（不断重置，收手才发车），叠加页面去重表（上限 512，键含 `level`）与 SW「命中 / 在途即 no-op」。
- 为什么不选其他：A 让整曲字节多穿一趟页面主线程且重复缓存逻辑；只预两档之一会在「列表行」或「沉浸页」其一留白。
- 后果 / 已知边界：
  - **首载无 controller** 时 `postToServiceWorker` 静默丢弃 → 音频预载缺席，**封面 / 歌词仍预**。
  - 预载等于提前下载「可能被跳过」的整曲：请求量约 +1 整曲 / 次切歌（±2 上限），上游风控与 VPS 流量为主要成本；`saveData` 兜底，快速连跳靠 `settle`。
  - 换档不清旧档缓存（与 ADR-031 一致，靠 LRU）；去重键含 `level` 故换档按新档重发。
  - 预载失败在**本会话内不重试**（先登记再执行，避免失败循环）。
  - 登录 / 登出清空全部缓存（ADR-034）时同步清空页面去重表；但此时 `current/queue/index` 未变 → effect 不重跑，预载需**下次切歌**才恢复。
- 何时重新审视：若引入音频分片缓存（ADR-012）可改为按需分段预热；若需给预载加显式取消协议或动态半径（如移动网络只预 ±1）。

## ADR-038：云同步强化——SQLite 存储 + 服务端版本 + 云端权威 + SSE 实时推送 + 登录默认开启

- 日期：2026-10-07
- 状态：已采纳（**修订 ADR-016 / ADR-028**）
- 背景：现网同步较薄——服务端按 `<source>-<id>` 存**单个 JSON 文件**（ADR-016），冲突用前端 `Date.now()` 时间戳做 LWW，开关默认**关闭**、须手动开，且没有任何**服务端 → 客户端**通道（换设备后要等本地再次触发才同步）。目标：更强、更适合规模、多设备近实时的同步。
- 考虑过的方案：
  - 存储：**A** 维持文件 JSON / **B** `node:sqlite`（内置、零依赖、磁盘索引）/ **C** `@seald-io/nedb`（Mongo 风格嵌入式）/ **D** `lowdb`。
  - 冲突：**E** 维持 LWW（谁的时间戳新谁胜）/ **F** 云端权威（进入即云端覆盖本地，云端为空则本地为准并上传）。
  - 实时：**G** 继续轮询 / **H** SSE（服务端推送版本信号）。
- 决策：**B + F + H**，并**登录即默认开启**同步。
  - 存储：新模块 `server/syncDb.ts` 用 `node:sqlite`（`DatabaseSync`）建表 `sync_docs(key PK, state JSON, rev, updated_at)`，库文件 `<DATA_DIR>/sync.db`（WAL）；首次打开把旧的 `sync/*.json` `INSERT OR IGNORE` 迁入。`syncStore.ts` 保持 `readLibrary/writeLibrary/clearLibrary` 的对外语义。
  - **服务端指派版本**：`rev`（每次写入 +1）与 `updatedAt`（服务端 `Date.now()`）都由服务端产生，客户端不再传时间戳（旧 LWW 的时间戳在跨设备时钟偏差下不可靠）。
  - 冲突：进入同步启用态（登录 / 开开关 / 打开页面）一律 `syncOnEntry()`：**拉到云端数据即以云端覆盖本地**，仅当**云端为空**才反过来以本地为准并上传（三处统一）。
  - 实时：`GET /api/sync/events`（SSE，`hono/streaming` 的 `streamSSE`），按账号（`<source>-<id>`）分组注册。`PUT` 成功后 `broadcast(key, { rev })`（**只推 rev**）；客户端收 `rev` 大于本机已知版本时重拉并应用。断开后每 **5s** 重连、**永不停止**。
  - 登录默认开启：`finishQrLogin` 成功后 `useSync.enable(source, userId)`。
- 为什么选这个：
  - **B**：零新依赖、磁盘索引 + WAL，比「每账号一个文件」更适合数据规模；仍按文档（`state` 存 JSON）使用，不涉关系建模。`node:sqlite` 可在 Node ≥ 22.5 使用，`23.4` 起无需 flag，故 `engines.node` 提升到 `>=23.4.0`。
  - **F**：本地每次变更都即时上行，云端即最新版本；进入即以云端为准可直接收敛多设备。为规避「云端为空却覆盖本地」的数据丢失，保留「云端空 → 本地为准」这一唯一分支。
  - **H**：SSE 比轮询省电省请求、延迟低；只推 `rev`（不推整份文档）使事件小、幂等、能容忍丢事件（断线重连后以重拉收敛）。
- 为什么选其他：A 在账号数 / 数据量增长后是「海量小文件」，无索引；C 数据常驻内存、超大库不划算；D 仍是最轻的整文件 JSON。E 的客户端时钟偏差会让「快钟设备」总是胜出；G 轮询延迟高、请求多。
- 后果 / 已知边界：
  - **登录 / 开开关 / 打开页面即用云端覆盖本地**：本地**尚未上传**的改动会被丢弃（云端为空时例外）。这是「每次操作都上云」模型的前提，离线编辑不被保留（已与用户确认）。
  - 部署：SSE 需 nginx `proxy_buffering off` + 足够长的 `proxy_read_timeout`（响应另带 `X-Accel-Buffering: no`）；后端仍为**单实例**（SQLite 不共享），水平扩展仍不成立。
  - `engines.node` 由 `>=20` 提升为 `>=23.4.0`；`tsup` 需 `removeNodeProtocol: false`，否则 `node:sqlite` 被剥成 `sqlite` 而启动即崩。
  - 身份边界不变：`/api/sync/*` 仍只以访客本人 cookie 解析身份，**绝不回退缺省凭证**。

## ADR-039：自定义应用背景与「从背景取主题色」

- 日期：2026-10-07
- 状态：已采纳（沉浸页部分**已被 ADR-041 修订**：自定义背景不再作用于沉浸页）
- 背景：需求——设置弹窗「音质」下方新增「背景」，允许上传图片 / 动图 / 视频作为应用背景（涵盖顶栏、侧边栏、主内容区，**不含底部播放条**），并自动从背景取色替换默认红主题色；此设置**仅存本地**。
- 决策：
  - 媒体本体落 **IndexedDB** 的**专用 `background` store**（IDB 库 v3 → v4；单条、固定键），settings store 只留轻量元数据 `{ kind, mime, accent }`（localStorage）。取色结果 `accent`（base hex）随元数据持久化，刷新无需重新取色、无闪变。
  - 渲染：`components/AppBackground.tsx` 作 `.app-shell` 内绝对定位层（`z-index: -1`，配合 `.app-shell { isolation: isolate }`；`inset: 0 0 var(--playerbar-height) 0` 恰好排除底栏）。有背景时在 `<html>` 打 `data-has-bg`，CSS 据此把 `.app-main` / `.sidebar` / `.topbar` 调得更透明（默认外观不变）。
  - 取色：`lib/accent.ts` 把图 / 视频首帧绘到 24×24 离屏 canvas 取平均色 → 规整到适合做强调色的饱和度 / 明度，派生 `--accent / --accent-hover / --accent-press / --accent-soft`；`hooks/useAccentFromBackground` 以 JS 覆写变量（仿 `useSourceTheme`），清除背景则回落 `:root` 的红。
  - 沉浸播放页（`NowPlaying`）：~~设了自定义背景即**隐藏封面**、背景改用（高斯模糊的）自定义图~~——**已被 ADR-041 废止**：自定义背景不再作用于沉浸页，恒定「封面 + 封面模糊背景」。
  - 生命周期：`lib/clearCaches.ts`（登录 / 退出清缓存，ADR-034）**不触碰** `background` store（背景是本地设置、与账号无关）；`lib/reset.ts`（整库重置）会清它。
- 为什么选这个：视频 / 动图动辄数 MB，localStorage ~5MB 且只存字符串，放不下 → 媒体本体必须落 IDB。独立 store 且**不参与媒体池 LRU**，避免被当作缓存淘汰。
- 后果 / 已知边界：设置项**不同步到云**（本地项）；浅色 / 深色下背景可见度靠 `data-has-bg` 的 `color-mix` 透明度调节；取色对灰度图会回落接近默认红。

## ADR-040：顶栏前进 / 后退也走内容区转场——自定义路由器包裹 popstate

- 日期：2026-10-07
- 状态：已采纳
- 背景：内容区转场（Apple Music 风格交叉溶解）此前只覆盖「跳转新地址」（`useViewNavigate` 同步包裹 `startViewTransition`）；顶栏前进 / 后退按钮（`navigate(-1)/navigate(1)`）经 `history.go` 触发 **popstate**，其更新是异步的，无法同步包裹，故**没有转场**。
- 考虑过的方案：① 维持现状；② 在早期 `popstate` 监听里起转场（依赖与 react-router 监听器的注册顺序，且其 `useSyncExternalStore` 式更新可能同步提交，`old` 快照会拍到新 DOM，脆弱）；③ **改用自定义路由器**，把转场统一上移到 `history.listen` 层。
- 决策：③。新组件 `components/AppRouter.tsx` 镜像 react-router 的 `<BrowserRouter>`（`useRef` 惰性 `UNSAFE_createBrowserHistory({ v5Compat: true })` + `useLayoutEffect(() => history.listen(...))` + `<Router location navigationType navigator>`），但把状态提交经 `startRouteTransition(update, dir)`；`main.tsx` 用它替换 `<BrowserRouter>`。方向由 `window.history.state.idx` 的前后增减判定（增为前进、减为后退）。`startRouteTransition` 转场期间在 `<html>` 打 `data-route-vt` 与 `data-route-dir`；CSS 为 `back` 定义**镜像**关键帧（旧内容向下淡出、新内容自上方滑入 = 逆速度播放）。`useViewNavigate` 与 `AppLink` 因此简化为直通（转场不再由它们包裹，避免与路由器层双裹）。
- 关键点：**后退不 `resetContentScroll()`**——后退要回到历史条目的原滚动位置，归零会把它记成 0 使滚动恢复失效（前进才归零）。
- 为什么选这个：转场集中在**一处**（路由器层），push 与 pop 行为一致；顺带让浏览器前进 / 后退、触控板滑动也获得同样的转场；用 `idx` 判方向无需自建栈。
- 后果 / 已知边界：依赖 react-router 的 `UNSAFE_createBrowserHistory`（标注为 unstable）；`data-route-vt` / `data-route-dir` 为瞬态标记，仅在转场期间存在。

## ADR-041：沉浸播放页改版——背景与自定义背景解耦、移动端封面点按、顶部音频流参数、音质两档

- 日期：2026-10-07
- 状态：已采纳（**部分修订** ADR-039 / ADR-031）
- 背景：沉浸页（`NowPlaying`）UI 需求：(1) 自定义应用背景不应再影响沉浸页；(2) 移动端默认展示更大的封面，点封面播放缩小动画并隐藏歌名 / 歌手以留出更大歌词区，再点复原——且大封面在矮屏下**不得把进度 / 控制区顶出视口**；(3) 「正在播放」标语彻底移除，其位置改为**如实展示当前音频流参数**（编解码 / 码率 / 采样率），**禁用「无损」这类不知所云的档位描述**；相应地设置弹窗「音质」只留两档。
- 决策：
  - **(1) 背景解耦**：删去 `NowPlaying` 的自定义背景分支（`useCustomBg` / `nowplaying--nocover` / 条件背景层与条件封面），沉浸页**恒定**「封面 + 封面模糊背景（双层防闪）」。自定义背景仅作用于 `.app-shell` 外壳（顶栏 / 侧栏 / 主内容区，见 ADR-039），不再跨界。
  - **(2) 移动端封面点按 + 防顶出**：新增 `nowplaying--focus` 态（组件状态 `lyricFocused`），仅在 `(max-width: 860px)` 生效；用新增的 `hooks/useMediaQuery` 门控 `onClick` / `role="button"` / `tabIndex`，桌面端不注入点按语义。默认封面 `min(64vw, 320px)`，点按后缩到 `min(32vw, 150px)`（`width`/`height` 过渡），并以 `max-height` + `opacity` 收起 `.nowplaying__info`（歌名 / 歌手）**与 `.nowplaying__controls`（播放控制组）**，腾出的高度由 `.nowplaying__lyrics`（`flex: 1`）吸收——专注态即「纯歌词」视图（仅剩头部、小封面、歌词、进度条）；切歌 / 收起沉浸页时复位。**防顶出**：封面尺寸同时受宽度、上限与**可视高度**三者约束——`min(64vw, 320px, calc(100svh - 300px))`（`vh` 兜底，地板 88px），矮屏（横屏 / 小窗口 / 带浏览器 UI）下由高度项收窄，使「头部 + 封面 + 面板固定内容（信息 / 进度 / 控制）」恒不超出视口。**高度项用 `svh` 而非 `dvh`**：`dvh` 随移动端地址栏收放实时变化，滚动歌词使地址栏收起 → dvh 变大 → 封面变大 → 控制区被逐步挤下去（「慢慢复位」）；`svh` 恒为最小值、不随滚动变化，布局稳定。
  - **(3) 顶部音频流参数**：移除「正在播放」标语与其后的 chip。顶部改为**如实展示解析到的流参数**，由 shared `formatQuality` 拼接 `编解码 · 码率 · 采样率`（如 `FLAC · 1411Kbps · 44.1kHz`），缺失字段按需省略、全缺则不渲染；**不出现档位名**（`无损` / `Hi-Res` 等）。数据来自后端**可选**适配器能力 `SourceAdapter.audioQuality?(id, cred, level)` 与路由 `GET /api/quality/:source/:id?level=`（含 2 段式别名；缺该能力回 501）：网易云读 `song_url_v1` 的 `type` / `encodeType` / `br` / `sr`（降级如实反映）；B 站由挑中的 `dash.audio` 条目取 `bandwidth` 与 `codecs` / `mimeType` 归一为 `AAC` 等（无采样率则不展示）。
  - **(4) 音质两档**：设置弹窗「音质」由 5 档收敛为**两档**——「一般」= 抽象档 `exhigh`（取流上限 320Kbps，**默认**）、「质量」= 抽象档 `hires`（取流上限 Hi-Res）。**两档对应的具体码率不在 UI 暴露**：按钮只写「一般 / 质量」，区块描述行也不提码率（具体在播参数交给沉浸页顶部）。底层仍复用 `AudioLevel`（`streamUrl` / 缓存键 / 下载链路零改动）；旧持久化值按「无损及以上算质量、其余算一般」归入模式，向后兼容。
- 考虑过的方案：
  - **流参数数据源**：① 仅用所选档位（纯前端，改动小）——放弃，无法反映降级（非 VIP 设 Hi-Res 实得 320Kbps 时会误报）；② **实际解析**（选中）——如实、与 Apple Music 语义一致。
  - **展示形式**：档位名（`无损` / `Hi-Res`）——放弃，语义不透明；改用**具体参数**（编解码 / 码率 / 采样率）。
  - **B 站流参数**：不实现（参数缺失）——放弃，MV 渠道体验不一致。
  - **防顶出**：只缩小封面但不定高——放弃，矮屏仍会顶出；改由 `100dvh` 参与 `min()` 直接约束封面。
- 为什么选这个：以「语义对齐」为准——背景与沉浸页职责分离；移动端把屏幕让给核心内容（歌词）且不牺牲控制可达性；音质信息说真话、说具体。
- 后果 / 已知边界：
  - 流参数查询每次展开沉浸页发起一次上游解析（后端按 `源|id|档位|凭证指纹` 缓存 15 分钟，只缓存成功结果，与音频地址缓存同容量 / TTL）；解析失败或该源未实现时不渲染，**绝不阻塞播放**。
  - 移动端封面尺寸过渡用 `min()` 逐分量插值（现代浏览器支持）；防顶出的 `calc(100svh - 300px)` 中的 300 依赖移动端 chrome（头部 + 信息 / 进度 / 控制）高度，改这几处版式需回归矮屏。**切勿改回 `dvh`**（见上：会随滚动抖动）。
  - 移动端沉浸页 inner 用 `env(safe-area-inset-bottom)` 为控制组留出安全区（刘海屏 / 手势条），避免被系统 UI 遮住（`viewport-fit=cover` 已在 `index.html` 设定）。
  - **问题 1 真因（移动端控制区被顶出）**：注入的实测（真实应用 + WebKit 引擎，700×760 连点 15 次换行）显示**静态布局不漂移**（`controlsBottom`/`lyricsClientH` 恒定），漂移来自**运行期**：歌词首/末行居中曾用 `.nowplaying__lyrics` 的 `padding-top/bottom`（JS 每次换行重设），等于每次都在改这个**滚动容器自身的盒模型**，触发它重新测高 → 顶动下方控制区；且 `position: fixed` 整页浮层在 macOS Safari 弹性滚动（滚动链抵达文档）时会整体位移。修法：留白改由 `::before`/`::after`（读 JS 写入的 `--np-lyric-pad`）撑起，容器盒模型恒定；容器再加 `overscroll-behavior: contain` 断开滚动链。**切勿改回容器 `padding`。**
  - 歌词居中须对**容器高度变化**（点封面进 / 出专注态、窗口缩放）即时响应：居中逻辑提取为回调用，`ResizeObserver` 观察 `.nowplaying__lyrics` 的盒尺寸并在变化时立即重居中（不加平滑）；否则点封面后当前行会偏，非得等到下一句才归位。
  - `useMediaQuery` 的断点常量须与 CSS 的 `860px` 同步；`AUDIO_LEVEL_LABELS` 已随 chip 一并移除。
