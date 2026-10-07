/**
 * `pnpm log-in [netease|bilibili]` —— 服务端缺省凭证的获取入口。
 *
 * 直接在**终端**渲染二维码，用对应 App 扫码；成功后将会话 cookie 写入仓库根 `.env` 的
 * `<SOURCE>_COOKIE`（`NETEASE_COOKIE` / `BILIBILI_COOKIE`），作为未登录访客的缺省凭证。
 *
 * 源由**第一个位置参数**指定（缺省 `netease`），实现上复用适配器注册表——两源的扫码
 * 契约一致（`qrCheck` 的 code 均归一为 800 过期 / 801 等待 / 802 待确认 / 803 成功），
 * 故一套流程通吃。B 站缺省凭证除提升音频码率外，还解锁**字幕歌词**（ADR-035）。
 *
 * 扫码状态由本进程统一轮询（每 1.5s），终端字样随「等待扫码 → 已扫码待确认 → 成功 /
 * 过期」变化；二维码过期会自动换一张新码。只依赖 Node 内置 + 适配器注册表与 `qrcode`。
 */
import QRCode from 'qrcode'
import type { MusicSource } from '@pterosaur/shared/types'
import { adapterOf } from '../sources/index.js'
import type { SourceAdapter } from '../sources/index.js'
import { ENV_PATH, upsertEnv } from '../env.js'

const TIMEOUT_MS = 5 * 60 * 1000
const POLL_MS = 1500

/** CLI 可登录的源与各自的扫码 App 名（键序即 usage 提示顺序）。 */
const SUPPORTED: Partial<Record<MusicSource, { app: string }>> = {
  netease: { app: '网易云音乐 App' },
  bilibili: { app: '哔哩哔哩 App' },
}

/** 带齐扫码三件套的适配器视图（`flavorOf` 已在运行时确保非空，收窄只为免散弹断言）。 */
type QrAdapter = SourceAdapter &
  Required<Pick<SourceAdapter, 'qrKey' | 'qrLoginUrl' | 'qrCheck'>>

/** 解析后的运行形态：源 + 扫码 App 名 + 适配器 + 落盘的 env 变量名。 */
interface Flavor {
  source: MusicSource
  app: string
  adapter: QrAdapter
  envName: string
}

/** 由命令行参数解析形态；不支持的源直接报错退出（列出可选项）。 */
function flavorOf(argv: string[]): Flavor | null {
  const raw = argv[2] ?? 'netease'
  const meta = SUPPORTED[raw as MusicSource]
  const adapter = adapterOf(raw as MusicSource)
  // 扫码三件套缺一即视为该源不支持 CLI 登录（契约上均为可选能力）
  if (!meta || !adapter?.qrKey || !adapter.qrLoginUrl || !adapter.qrCheck)
    return null
  return {
    source: raw as MusicSource,
    app: meta.app,
    adapter: adapter as QrAdapter,
    envName: `${raw.toUpperCase()}_COOKIE`,
  }
}

let flavor!: Flavor
let currentKey = ''
let finished = false
let lastLogged = ''
let timeoutTimer: NodeJS.Timeout | undefined

/** 去重打印状态字样，避免每 1.5s 刷屏。 */
function logOnce(text: string): void {
  if (text === lastLogged) return
  lastLogged = text
  console.log(`[pterosaur] ${text}`)
}

/** 重置「二维码有效期」计时（每张新码各给一份窗口）。 */
function resetTimeout(): void {
  if (timeoutTimer) clearTimeout(timeoutTimer)
  timeoutTimer = setTimeout(() => {
    console.error(
      `\n[pterosaur] 二维码已超时，请重新运行 pnpm log-in ${flavor.source}\n`,
    )
    shutdown(1)
  }, TIMEOUT_MS)
  timeoutTimer.unref()
}

/** 生成并打印一张二维码。 */
async function showQr(): Promise<void> {
  const key = await flavor.adapter.qrKey()
  if (!key) throw new Error('无法生成二维码 key')
  const url = await flavor.adapter.qrLoginUrl(key)
  if (!url) throw new Error('无法生成二维码内容')
  currentKey = key
  lastLogged = ''

  const art = await QRCode.toString(url, { type: 'terminal', small: true })
  console.log(
    `\n[pterosaur] 用 ${flavor.app} 扫描下方二维码，并在手机上确认：\n`,
  )
  console.log(art)
  resetTimeout()
}

/** 轮询一次扫码状态；803 落盘并退出，800 自动换码。 */
async function poll(): Promise<void> {
  if (finished) return

  let res: { code: number; cookies?: string[] }
  try {
    res = await flavor.adapter.qrCheck(currentKey)
  } catch {
    return // 上游抖动：保持现状，下次轮询再试
  }

  if (res.code === 803) {
    const cookie = flavor.adapter.cookieHeaderFromSetCookies(res.cookies)
    if (!cookie) {
      logOnce('登录成功但未取到会话 cookie，正在重试…')
      return
    }
    upsertEnv(flavor.envName, cookie)
    upsertEnv(`${flavor.envName}_UPDATED_AT`, new Date().toISOString())
    const st = await flavor.adapter.loginStatus(cookie)
    console.log(`\n[pterosaur] 登录成功：${st.nickname ?? '（未知）'}`)
    console.log(`[pterosaur] 凭证已写入 ${ENV_PATH}（${flavor.envName}）`)
    console.log(
      '[pterosaur] 重启服务（pnpm dev / pnpm start）后对未登录访客生效。\n',
    )
    shutdown(0)
    return
  }

  if (res.code === 800) {
    console.log('\n[pterosaur] 二维码已过期，自动换一张…')
    try {
      await showQr()
    } catch (e) {
      console.error(`\n[pterosaur] 刷新二维码失败：${(e as Error).message}\n`)
      shutdown(1)
    }
    return
  }

  logOnce(res.code === 802 ? '已扫码，请在手机上确认…' : '等待扫码…')
}

function shutdown(code: number): void {
  if (finished) return
  finished = true
  if (timeoutTimer) clearTimeout(timeoutTimer)
  // 上游库可能持有 keep-alive 句柄，确保进程真正退出。
  process.exit(code)
}

async function main(): Promise<void> {
  const f = flavorOf(process.argv)
  if (!f) {
    console.error(
      `\n[pterosaur] 不支持登录的源：${process.argv[2] ?? ''}（可选：${Object.keys(SUPPORTED).join(' / ')}）\n`,
    )
    shutdown(1)
    return
  }
  flavor = f
  console.log(
    `\n[pterosaur] 扫码登录缺省账号（${f.source}，供未登录访客解锁受限能力）`,
  )
  await showQr()
  setInterval(() => void poll(), POLL_MS)
}

process.on('SIGINT', () => {
  console.log('\n[pterosaur] 已取消')
  shutdown(130)
})

main().catch((e: Error) => {
  console.error(`\n[pterosaur] 启动失败：${e.message}\n`)
  shutdown(1)
})
