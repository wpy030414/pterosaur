# 网易易盾（Watchman / NEFingerprint）逆向（2026-10）

> 目标：把网易云网页登录风控所依赖的 `ydDeviceToken` 从「必须有浏览器」变成「纯 Node 可生成」。
> 结论先行：**已啃穿**——加密算法完整逆向并移植，纯 Node 生成的 token 被 `fp-upload` 接受（`code:200` + `dt`），且**设备风控在真实扫码中放行**（无 8821）。
>
> 前置阅读：`netease-web-login-protocol.md`（登录协议与 8821 根因）。本文只讲易盾那一层。
> 证据范围：线上 bundle 静态解混淆 + 运行时 hook 抓明文 + Node `fetch` 实测。凡未验证处均标注。

## 1. 两套东西，别混

网易云网页里跑着**两个**易盾组件，名字都带 watchman，容易混：

| 组件                      | 载体                                                                  | 职责                                                         | 产出                                  | 登录是否必需                    |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------- |
| **NEWatchman**（反爬）    | `acstatic-dun.126.net/<ver>/watchman.min.js`                          | 环境探测 + `POST ac.dun.163.com/v3/d` 上报                   | cookie `WM_TID` / `WM_NIKE` / `WM_NI` | **否**（实测不带也能过，见 §6） |
| **NEFingerprint**（指纹） | `st.music.163.com/device/signature/create/deviceid.js`（340KB，混淆） | 采集 86 项指纹 → 加密 → `POST fp-upload.dun.163.com/v2/js/d` | `dt` = **`ydDeviceToken`**（32 字符） | **是**（空则 802→8821）         |

登录轮询要的 `ydDeviceToken` 来自**后者**。`createNEFingerprint({appId:"9d0ef7e0905d422cba1ecf7e73d77e67"})` 由 `deviceid.js` 注入 `window`，官方登录 bundle 的 `getYdDeviceToken()` 只是包了一层 Promise。

## 2. 定位手法

`deviceid.js` 是 340KB 单行混淆，静态搜 `fp-upload` 搜不到（字符串被编码）。有效路径是**用运行时调用栈反查**：

```js
// addInitScript 提前包装 XHR.open/send 与 fetch，命中上报域名时打印 new Error().stack
page.addInitScript(() => {
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (...a) {
    if (/fp-upload|\/v2\/js\/d/.test(this.__url || '')) {
      console.log('STACK:\n' + new Error().stack)
    }
    return origSend.apply(this, a)
  }
})
```

栈帧直接供出 `deviceid.js:1:160073` 等偏移——按字节偏移切开读，比全文搜索快得多（复现脚本：`.scratch/fp-stack.mjs`）。

## 3. 解混淆

混淆是 **obfuscator.io 字符串数组**家族，两层嵌套（外层 `Zw` + 内层 `a0_0x2d2b`）：

```js
function Uw(t, r) {
  var e = Zw[t -= 292]           // ① 索引偏移 292 取编码串
  ...
  Uw.rvLuoJ = function (t) {     // ② 自定义字母表 base64 → 字节
    // 字母表：abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=
    // （注意：小写在前！与标准 base64 不同）
    ...
  }
  // ③ 字节 → %XX → decodeURIComponent（UTF-8 还原）
  var n = t + Zw[0], i = Uw.PESHrW[n]   // ④ 以「索引+数组首元」为键做记忆化缓存
  ...
}
```

解码器只需按语义重写（照抄易错，`for(...)` 里塞了逗号表达式）：

```js
const ALPHA =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='
function decode(idx) {
  const t = Zw[idx - 292]
  const bytes = []
  let acc = 0,
    bits = 0
  for (const ch of t) {
    const v = ALPHA.indexOf(ch)
    if (v < 0 || v === 64) continue // 表外字符与 '=' 填充跳过
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return decodeURIComponent(
    Buffer.from(bytes)
      .toString('latin1')
      .replace(
        /[\s\S]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'),
      ),
  )
}
```

再做全文替换（`IDENT(数字)` → 字符串字面量），**1439 条字符串、3953 处调用**全部还原，代码即刻可读（脚本 `.scratch/fp-deob2.mjs`，产物 `deviceid.deob.js`）。

替换正则要注意标识符长度上限：源码里的解码器别名是 `t`/`r`/`e`/`n`/`i`/`o`/`u`/`a`/`c`/`f`/`s`/`v`/`l`/`d`/`h`/`y`/`p`/`g`/`w` 这种单字母，写死 `[a-zA-Z_$][\w$]{0,3}` 足够且不会误伤。

## 4. 上报协议

```
POST https://fp-upload.dun.163.com/v2/js/d
Content-Type: application/json

{"p":"9d0ef7e0905d422cba1ecf7e73d77e67",   // appId
 "v":"2.0.1",                               // sdkVersion
 "vk":"d44593ca",                           // versionKey
 "n":"<uuid32>",                            // nonce（每次随机）
 "d":"<Mb 加密结果>"}                        // 见 §5
```

响应：

```json
{"code":200,"data":{"dt":"<32字符 token>","st":<服务器时间戳>,"tid":"<trackId>"},"msg":"ok"}
```

- `dt` 就是 **`ydDeviceToken`**；`tid` 会被 SDK 存进 `ntes_utid` cookie（下次上报作为 TLV id=3 回传）。
- SDK 内部**24h 只上报一次**（localStorage 键 `ntes_fp_<md5(appId)>` 存 `{tk, cf, tid}`，带时间戳判断 `< 864e5`）。
- `sdkType = 1`；离线降级 token 形如 `"1#" + base64(JSON)`（见 §7）。

## 5. `d` 字段的加密（`Mb`）

### 5.1 明文：TLV 采集流

86 项指纹，每项 `[id:2B][len:2B][value]`，**有符号字节**（`Rm()` 折叠到 `[-128,127]`，移植时统一转无符号存储、运算时再折叠）。`Mb` 的入参 = 采集项 flatten 后 **拼上 `ib(fb(data))`**（即 CRC32 的 8 位 hex 字符串的字节形式）。

采集项由 5 个包装器编码，都是 TLV，只有 value 编码不同：

| 包装器          | value 编码                                  | 典型项                |
| --------------- | ------------------------------------------- | --------------------- |
| `hx(fn,id,len)` | 字符串 → `ib()`（UTF-8 字节），截断到 `len` | UA、语言、canvas 色值 |
| `lx(fn,id,len)` | 数值 → `eb()`（4 字节大端），截断           | 时长、计数            |
| `sx(fn,id,len)` | 布尔 → `eb(1                                | 2)`                   | 各类特性探测 |
| `wx(fn,id,len)` | 数值 → 左补 0 的 hex 串 → `nb()`            | 定时/性能类           |
| `px(fn,id,len)` | 数组 → 每项 `eb()` 后按 `len` 截断拼接      | 屏幕尺寸等            |

`ix(v, len)` = `v.slice(-len)`（**从尾部**截取），`eb(n)` = 32 位拆 4 字节大端，`nb(hex)` = hex 转字节。

完整 id 清单（实测快照，值已截断）：

|                                  id |     len | 含义（推断）                                        | 值样例                             |
| ----------------------------------: | ------: | --------------------------------------------------- | ---------------------------------- |
|                                   2 |      32 | appId                                               | `9d0ef7e0…7e67`                    |
|                                   3 |       0 | trackId（首次空，之后是上次的 `tid`）               | —                                  |
|                                   4 |       5 | sdkVersion                                          | `2.0.1`                            |
|                                   5 |      32 | nonce（uuid32 无横线）                              | `aa13f171…`                        |
|                                   6 |      13 | timestamp（ms）                                     | `1793335404755`                    |
|                             200/233 | 133/125 | userAgent / appVersion                              | `Mozilla/5.0 (Windows…`            |
|                             201/234 |       5 | language                                            | `zh-CN`                            |
|                             202…211 |       1 | 各类布尔探测（webdriver / phantomjs / selenium 等） | `01`/`02`                          |
|                                 213 |       5 | platform                                            | `Win32`                            |
|                                 214 |       7 | deviceMemory 类                                     | `unknown`                          |
|     216/217/240/273/281/900/902/904 |      16 | 各类 hash（canvas/webgl/audio/font）                | `0d30d272…`                        |
|                                 239 |      10 | compatMode                                          | `CSS1Compat`                       |
| 241/242/260/271/272/278/502/508/713 |    2-10 | 屏幕/视口尺寸类（大端数值）                         | `050002d0…`                        |
|                                 252 |      31 | 音频设备枚举                                        | `48000,2,1,0,2,explicit,speakers`  |
|                         253/262/510 |    7-13 | WebRTC 泄漏的本地/公网 IP                           | `0.0.0.0` / `124.73.205.80`        |
|                                 255 |       5 | 字符编码                                            | `UTF-8`                            |
|                                 265 |      26 | mediaDevices 枚举                                   | `audioinput__,audiooutput__`       |
|                                 268 |     261 | canvas 色值采样                                     | `255_255_255,240_240_240,…`        |
|                             270/283 |  24/219 | plugins MIME / 详情                                 | `application/pdf,text/pdf`         |
|                     279/500/503/505 |    3-19 | 各类计时（`Math.PI**random` 空转 5e6 次等）         | `22221` / `2222…`                  |
|                                 284 |     149 | uaData（架构 + brands + 版本）                      | `x86,Not:A-Brand_8,Chromium_156,…` |
|                                 509 |      13 | window toString                                     | `object Window`                    |
|                                 513 |      15 | document.title 的 UTF-8 字节                        | `网易云音乐`                       |
|                             515/516 |       4 | collectDuration / visitDuration（ms，大端）         | `00000234`                         |
|                                 700 |      22 | location.href                                       | `https://music.163.com/`           |
|                     800/802/803/804 |       8 | 4 项 CRC32 片段（hex 字符串）                       | `5bf1626b`                         |
|                                 901 |     100 | WebGL renderer（ANGLE 串）                          | `Google Inc. (AMD):ANGLE (…)`      |

### 5.2 加密算法

```js
function Mb(r) {
  const [f, s] = zb() // f = 64B salt（循环），s = 4B 随机种子
  const v = ib(fb(r)) // CRC32(r) → 8 位 hex → 字节
  const data = r.concat(v) // 明文 + 校验尾
  // padding：补 0 到 64 的倍数，末尾 4 字节写原始长度（大端）
  const padCount = len % 64 <= 60 ? 64 - (len % 64) - 4 : 128 - (len % 64) - 4
  // 逐 64 字节块（CBC 式，prev 链）
  let h = f
  for (let y = 0; y < blocks.length; y++) {
    let g = rb(Lb(blocks[y]), f) // ① Lb 4 轮变换 ② 异或 salt
    g = rb($m(g, h), h) // ③ 加 prev ④ 异或 prev
    h = hb(hb(g)) // ⑤ 双 S 盒
    out.set(h, 64 * y + 4) // 写入输出（前 4 字节留给 s）
  }
  return vb(out, MB_ALPHABET, '7') // 自定义字母表 base64，pad 字符是 '7'
}
```

各部件：

- **`zb()`**：`seed = "fd6a43ae25f74398b61c03c83be37449"`（16B）→ `db()` 循环填充到 64B；`e` = 4 个随机字节 → `db()` 到 64B；`salt = rb(db(seed), db(e))` 取前 64B。**salt 由 e 决定，而 e 原样嵌在输出前 4 字节**——服务器无需共享密钥即可还原 salt，这套东西是**混淆而非密钥交换**。
- **`Lb()`**：表驱动 4 轮，表 `"037606da0296055c"`，每 4 位 hex 拆成 `[操作码, 参数]`；操作码索引到 `[xb 恒等, yb 异或常量, wb 加常量, pb 异或递增, mb 加递增, gb 异或递减, bb 加递减]`。实测 4 轮为 `03/76`、`06/da`、`02/96`、`05/5c`。
- **`hb()`**：S 盒置换，256 字节表（`a7be3f3933fa8c5f…`），索引 `16*(b>>>4&15) + (b&15)`——等价于 `SBOX[b]`，写成两级只是为了混淆。
- **`$m` / `rb`**：逐字节加法 / 异或，key 循环取模。
- **`Rm()`**：折叠到有符号 `[-128,127]`（原代码用递归，移植改 while 循环，语义等价且不会栈溢出）。
- **`vb`/`sb`**：3 字节一组转 4 字符，字母表 `"MB.CfHUzEeJpsuGkgNwhqiSaI4Fd9L6jYKZAxn1/Vml0c5rbXRP+8tD3QTO2vWyo"`，不足补 `'7'`。
- **`_m()`**：Fisher-Yates 洗牌，作用于**TLV 记录层**（不打乱记录内部）；服务端按 id 解析，**顺序无关**，移植时可直接不洗。

### 5.3 移植验证

| 检查项                   | 结果                                      |
| ------------------------ | ----------------------------------------- |
| `fb(ib("abc"))`          | `352441c2` ✓（标准 CRC32）                |
| `Mb(捕获明文)` 输出长度  | **2652**，与线上捕获的 `d` **完全一致** ✓ |
| 纯 Node 请求 `fp-upload` | `code:200`，`dt` 32 字符 ✓                |

（Node 移植：`.scratch/fp-mb.cjs`；验证：`fp-verify.cjs`）

## 6. 关键发现：服务器不校验指纹值

用同一份 TLV 模板只改若干项再上报，**全部照发 token**：

| 改动                                        | 结果         |
| ------------------------------------------- | ------------ |
| 基线（快照原样）                            | `code:200` ✓ |
| IP(510) 改成 `1.2.3.4`                      | `code:200` ✓ |
| IP(510) 清空                                | `code:200` ✓ |
| UA(200) 换成 Linux Firefox                  | `code:200` ✓ |
| canvas(268) 清空                            | `code:200` ✓ |
| webgl(901/902/904) 清空                     | `code:200` ✓ |
| 全部高熵 hash(216/217/240/273/281/900) 清空 | `code:200` ✓ |

即 `fp-upload` 只做**格式/解密校验**，不做指纹合理性或一致性判定。（脚本 `.scratch/fp-probe.cjs`）

## 7. 真人扫码验证（决定性）

纯 Node 生成 token + **完全不带 WM cookie**（只有 `_ntes_nnid`/`NMTID` 等常规项）+ `chainId` 用 `unknown-<随机>`：

```
801 等待扫码 → 802 授权中 → （停 2 分钟）→ 800 二维码过期
```

**全程无 8821**。对照三次实验的 802 之后行为：

| 实验               | ydDeviceToken | WM cookie  | 802 之后                       |
| ------------------ | ------------- | ---------- | ------------------------------ |
| A（ADR-051 基线）  | 空串          | 无         | **2.1s → 8821**                |
| B（ADR-052）       | headless 取   | 有（全套） | **1.2s → 803**（MUSIC_U 下发） |
| C（本次，纯 Node） | **Node 算的** | **无**     | 无 8821，停在 802 直到过期     |

C 卡在 802 的原因与协议无关：当天真人扫码次数过多，**手机端弹「24 小时后再试」**，授权无法回写，网页侧只能等到二维码自然过期。风控若要拒这个 token，8821 会在 2 秒内出现（实验 A 的时间线为证）——它没出现，即**设备风控放行了纯 Node token**。

由此还能读出两条附带结论：

1. **WM cookie 不是登录必需**（C 完全没带，仍无 8821）。ADR-052 里「一并携带」属保守做法，可降级为可选。
2. **真实 `sDeviceId` 不是必需**（C 用的 `unknown-<随机>`），与 `netease-web-login-protocol.md` §2.2 的「未验证」项对上。

## 8. 离线降级路径（SDK 自带）

`send` 的 `catch` 分支里有一条**不联网**的 token 生成路径：

```js
p = rx({ p: appId, v: sdkVersion, vk: versionKey, n: nonce, d: i() }) // rx = JSON.stringify
g = '1#'.concat(lb(ib(p))) // lb = 标准 base64（A-Za-z0-9+/）
return [g, !1] // 第二值 false = 未联网
```

即网络失败时 token 形如 `1#<标准base64(JSON)>`。**未验证**：这种离线 token 能否过登录风控（本次没走到该分支）。若可用，则连 `fp-upload` 都不必请求，登录彻底离线自足。

## 9. 结论与落地建议

- **加密已完全掌握**，纯 Node 可生成被上游接受的 `ydDeviceToken`；`fp-upload` 不校验指纹内容，故**无需真实浏览器指纹**，一份静态 TLV 模板 + 每次刷新 nonce/timestamp/hash 即可。
- 建议把 ADR-052 的 headless 方案改为**双通道**：纯 Node 复刻为**主路径**（零浏览器依赖、零 playwright、启动即就绪、Linux 服务器友好），headless 保留为**降级/自愈**（万一上游收紧校验、或复刻失效时兜底）。
- 复刻需要的常量共 4 组：S 盒 256B、`Lb` 轮表 16 hex、`zb` 种子 16B、base64 字母表 64 字符——建议连同 TLV 模板一起固化到源码并加注释来源，便于上游改版时比对。
- 未验证项：① C 的 803 未取到（账号频控），需 24h 后补一次真人验证以确证闭环；② §8 离线 token 的接受度；③ token 跨会话复用上限（官方 24h 缓存暗示可复用）。

## 附录：复现脚本

| 脚本                                    | 作用                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `.scratch/fp-stack.mjs`                 | hook XHR/fetch 抓调用栈，定位 SDK 文件与偏移         |
| `.scratch/fp-deob.mjs` / `fp-deob2.mjs` | 提取 `Zw` 数组、解码 1439 条字符串、全量替换 3953 处 |
| `.scratch/fp-hook-mb.mjs`               | route 拦截 `deviceid.js`，在 `Mb` 入口注入明文记录   |
| `.scratch/fp-parse-tlv.mjs`             | 解析 TLV 流（86 项）                                 |
| `.scratch/fp-mb.cjs`                    | **Node 移植**（`Mb` 全链路 + CRC32 + 自定义 base64） |
| `.scratch/fp-verify.cjs`                | 纯 Node 造 `d` 打 `fp-upload` 换 `dt`                |
| `.scratch/fp-probe.cjs`                 | 指纹值校验严格度探测                                 |
| `.scratch/fp-login-pure.cjs`            | 零浏览器完整登录验证                                 |
