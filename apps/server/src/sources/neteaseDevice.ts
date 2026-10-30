/**
 * 网易云「设备身份」提供者——扫码登录过 8821 设备风控的钥匙。
 *
 * ## 背景（2026-10 实测，证据见 docs/researches/netease-web-login-protocol.md）
 *
 * 扫码轮询 `POST /api/login/qrcode/client/login` 若不带 `ydDeviceToken`，
 * 手机端确认后服务端不回 803，而是 8821（「请切换其他登录方式或升级新版本再试」）——
 * 设备风控拦下了网页会话。官方网页由 `st.music.163.com/device/signature/create/deviceid.js`
 * 注入的 `createNEFingerprint({appId:"9d0ef7e0905d422cba1ecf7e73d77e67"})` 取 token
 * （SDK 内部 24h 才上报一次），随轮询请求回传；同时浏览器里 watchman 反爬
 * （`ac.dun.163.com`）会种下 `WM_TID` / `WM_NIKE` / `WM_NI` / `sDeviceId` 等 cookie。
 *
 * 本模块用 playwright-core 驱动系统浏览器（Edge/Chrome，headless）打开网易云首页，
 * 让官方 SDK 自己跑完取 token + 种 cookie，再把这套身份借给 Node 侧的明文请求：
 *
 * - 进程内缓存，TTL 20h（官方 SDK 24h 上报一次，留 4h 余量）；
 * - headless 失败（未装 playwright-core / 没有系统浏览器 / 上游改版）时缓存**负结果**
 *   60s，期间不重试——登录体验回落到「不带 token、扫码后 8821」，不会更糟；
 * - 并发调用共享同一个 inflight，不会同时起多个浏览器；
 * - 全部 API 不抛异常：拿不到就给空身份，调用方降级即可。
 */

/** 与 headless 浏览器上下文、Node 侧请求共用的 UA（实验验证通过的组合）。 */
export const NETEASE_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'

/** NEFingerprint 的 appId（网易云网页登录专用，官方登录 bundle 写死）。 */
const FP_APP_ID = '9d0ef7e0905d422cba1ecf7e73d77e67'

/**
 * 借给登录请求的 cookie 白名单。全部来自实测 headless 会话里网易云/易盾所种，
 * 百度统计（`Hm_*`）等与登录无关的不带。
 */
const DEVICE_COOKIE_ALLOWLIST = new Set([
  'WM_NI',
  'WM_NIKE',
  'WM_TID',
  'WM_DID',
  'sDeviceId',
  'NMTID',
  '_ntes_nnid',
  '_ntes_nuid',
  '_iuqxldmz_',
  'JSESSIONID-WYYY',
  'WEVNSM',
  'WNMCID',
  'ntes_utid',
  'HMACCOUNT',
])

/** 一套借来的设备身份。`token` 为空串表示降级（headless 不可用或尚未就绪）。 */
export interface NeteaseDeviceIdentity {
  /** `ydDeviceToken`——NEFingerprint 的 32 字符 token；降级时空串。 */
  token: string
  /** 白名单 cookie 拼好的请求头值（`k=v; k=v`）；降级时空串。 */
  cookieHeader: string
  /** 真实设备 id（chainId 用）；可能缺省。 */
  sDeviceId?: string
}

/** 缓存有效期：官方 SDK 24h 上报一次，提前 4h 失效。 */
const IDENTITY_TTL_MS = 20 * 60 * 60 * 1000
/** headless 失败后的负结果缓存，防止每次轮询都白起一次浏览器。 */
const FAILURE_TTL_MS = 60 * 1000

let cached: { identity: NeteaseDeviceIdentity; at: number } | null = null
let inflight: Promise<NeteaseDeviceIdentity> | null = null
/** 上次 headless 失败时刻：8821 自愈会高频触发 refresh，失败后必须节流（见下）。 */
let lastFailureAt = 0

/** 读缓存（不触发刷新）。inflight 未完成时返回 null——调用方降级即可，下次就有了。 */
export function getCachedNeteaseDeviceIdentity(): NeteaseDeviceIdentity | null {
  if (!cached) return null
  const ttl = cached.identity.token ? IDENTITY_TTL_MS : FAILURE_TTL_MS
  if (Date.now() - cached.at > ttl) return null
  return cached.identity
}

/** 作废缓存（如轮询命中 8821 风控码时），下次 refresh 重新起浏览器取。 */
export function invalidateNeteaseDeviceIdentity(): void {
  cached = null
}

/** 后台刷新设备身份（fire-and-forget；inflight 去重 + 失败节流见 refreshInflight）。 */
export function refreshNeteaseDeviceIdentity(): void {
  void refreshInflight()
}

async function refreshInflight(): Promise<NeteaseDeviceIdentity> {
  if (inflight) return inflight
  // 失败节流：上一轮 headless 失败后 60s 内不再起浏览器。
  // 8821 自愈路径（invalidate + refresh）在前端继续轮询时每秒都会触发，没有节流
  // 会在无浏览器的部署上每秒空跑一次浏览器探测（invalidate 清缓存不影响节流）。
  if (lastFailureAt && Date.now() - lastFailureAt < FAILURE_TTL_MS) {
    return cached?.identity ?? { token: '', cookieHeader: '' }
  }
  inflight = (async () => {
    const identity = await runHeadless()
    lastFailureAt = identity.token ? 0 : Date.now()
    cached = { identity, at: Date.now() }
    return identity
  })()
    .catch(() => {
      // runHeadless 内部已兜底为空身份；这里防御最外层意外（如 OOM）
      const identity: NeteaseDeviceIdentity = { token: '', cookieHeader: '' }
      cached = { identity, at: Date.now() }
      return identity
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 首次登录（或缓存过期后）主动等一份身份；超时/失败降级空身份。适合低频 CLI 场景。 */
export async function ensureNeteaseDeviceIdentity(
  timeoutMs = 12_000,
): Promise<NeteaseDeviceIdentity> {
  const hit = getCachedNeteaseDeviceIdentity()
  if (hit) return hit
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
  })
  try {
    return (await Promise.race([refreshInflight(), timeout])) ?? {
      token: '',
      cookieHeader: '',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * headless 取身份。逐个尝试系统浏览器通道（Edge → Chrome → 默认 chromium），
 * 任一步失败都收敛为空身份（不抛）。浏览器进程在 finally 里确保关闭，防泄漏。
 */
async function runHeadless(): Promise<NeteaseDeviceIdentity> {
  const pw = await import('playwright-core').catch(() => null)
  if (!pw) return { token: '', cookieHeader: '' }

  for (const channel of ['msedge', 'chrome', undefined] as const) {
    const identity = await tryWithChannel(pw, channel).catch(() => null)
    if (identity) return identity
  }
  return { token: '', cookieHeader: '' }
}

type PlaywrightModule = Awaited<typeof import('playwright-core')>

async function tryWithChannel(
  pw: PlaywrightModule,
  channel: string | undefined,
): Promise<NeteaseDeviceIdentity | null> {
  let browser: Awaited<ReturnType<PlaywrightModule['chromium']['launch']>> | null = null
  try {
    browser = await pw.chromium.launch({ headless: true, channel })
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      userAgent: NETEASE_WEB_UA,
    })
    const page = await ctx.newPage()
    await page.goto('https://music.163.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    })
    // deviceid.js 异步注入 createNEFingerprint；就绪后直接调 getToken（SDK 自带上报与缓存）
    // 回调在浏览器上下文执行，序列化后 globalThis 即 window；类型上避开 DOM lib。
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as Record<string, unknown>)
          .createNEFingerprint === 'function',
      null,
      { timeout: 15_000, polling: 250 },
    )
    const token = await page.evaluate(async (appId) => {
      try {
        const factory = (
          globalThis as unknown as {
            createNEFingerprint: (o: { appId: string; timeout: number }) => {
              getToken: () => Promise<{ token?: string }>
            }
          }
        ).createNEFingerprint
        const r = await factory({ appId, timeout: 8000 }).getToken()
        return r?.token ?? ''
      } catch {
        return ''
      }
    }, FP_APP_ID)
    const cookies = await ctx.cookies('https://music.163.com')
    const picked: string[] = []
    let sDeviceId: string | undefined
    for (const c of cookies) {
      if (!DEVICE_COOKIE_ALLOWLIST.has(c.name)) continue
      picked.push(`${c.name}=${c.value}`)
      if (c.name === 'sDeviceId') sDeviceId = c.value
    }
    if (!token) return null
    return { token, cookieHeader: picked.join('; '), sDeviceId }
  } finally {
    await browser?.close().catch(() => {})
  }
}
