import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.js'
import { loadEnv } from './env.js'
import { sweepStaleBurnDirs } from './rip.js'
import { refreshNeteaseDeviceIdentity } from './sources/neteaseDevice.js'

// 先加载仓库根 .env（缺省凭证 NETEASE_COOKIE，以及可选的 PORT / HOST 等），
// 必须在读取 process.env 之前调用。
loadEnv()

const app = createApp()

// 清扫刻录暂存残留（进程崩溃 / 强杀后的孤儿目录）；best-effort，不阻塞启动
void sweepStaleBurnDirs()

// 预热网易云设备身份（headless 取 ydDeviceToken + WM cookie，扫码登录过 8821 风控用；
// 见 sources/neteaseDevice.ts）。best-effort：失败留 60s 负缓存，登录时会再兜底。
refreshNeteaseDeviceIdentity()

const isProd = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8788)
const host = process.env.HOST ?? '0.0.0.0'

if (isProd) {
  // 生产：同一进程同时提供前端静态资源与 API（单一同源，无 CORS / 混合内容问题）。
  // tsup 输出到 apps/server/dist/，web 构建到 apps/server/dist/client/
  const distRoot = './dist/client'

  // 静态资源（带哈希的 js/css/图片等）
  app.use('/*', serveStatic({ root: distRoot, rewriteRequestPath: (p) => p }))

  // SPA 回退：非 /api、非 /stream 的路由统一交给 index.html
  app.get('*', serveStatic({ root: distRoot, path: '/index.html' }))
}

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${info.port}`
  console.log(
    `[pterosaur] ${isProd ? 'production' : 'dev'} server listening on ${url}`,
  )
})
