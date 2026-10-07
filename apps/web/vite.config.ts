import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 后端 API 端口（Hono / @hono/node-server）
const API_PORT = process.env.API_PORT ?? '8788'
const API_TARGET = process.env.API_TARGET ?? `http://127.0.0.1:${API_PORT}`

/**
 * 构建期取当前 commit 的短哈希（前 7 位），注入为全局常量 `__COMMIT_HASH__`。
 * 非 git 环境（如从归档构建）回退为 `dev`。
 */
function commitHash(): string {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // dev 下 SW 源码位于 `/src/sw.ts`，其默认作用域会被限制为 `/src/`，从而**永远不控制 `/` 下的页面**
    // （于是音频 / 封面都不会被缓存）。这里为该响应补上 `Service-Worker-Allowed: /`，
    // 使 `main.tsx` 能以 `scope: '/'` 注册。生产由 `/sw.js` 天然位于根作用域，无需此插件。
    {
      name: 'pterosaur:dev-sw-scope',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/src/sw.ts' || req.url?.startsWith('/src/sw.ts?')) {
            res.setHeader('Service-Worker-Allowed', '/')
          }
          next()
        })
      },
    },
    // PWA：沿用现有的手写 SW（`src/sw.ts`）作为唯一 SW，由 injectManifest 注入 precache 清单并
    // 构建为单文件 `sw.js`（IIFE，保持经典 SW 的非模块姿态）。应用外壳的 7 天过期缓存在
    // `src/lib/shellCache.ts` 里以 runtime caching 实现（**不用 precache**，因其条目永不过期）。
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // 注册由 `main.tsx` 手工完成；`false` 仍会注入 <link rel="manifest">，但不会注入 registerSW.js
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      includeManifestIcons: false,
      includeAssets: [],
      injectManifest: {
        // 只 precache 静态图标 —— 不含 js/css/html（外壳走 runtime caching，见 shellCache.ts）
        globPatterns: ['**/*.{svg,png,ico}'],
        rollupFormat: 'iife',
      },
      // dev 维持现状：由 `main.tsx` 以模块 SW 注册 `/src/sw.ts`
      devOptions: { enabled: false },
      manifest: {
        name: 'Pterosaur · 音乐',
        short_name: 'Pterosaur',
        description: '仿 Apple Music 的网页音乐播放器，无需登录即可畅听。',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#000000',
        theme_color: '#1c1c1e',
        // 图标集仅 4 个：favicon.svg（标签页，见 index.html）+ pwa-192 / pwa-512 + apple-touch-icon。
        // 512 那张为全出血红底、图形落在安全区内，故直接兼作 maskable，不必再单独产出一份。
        // 生成器源在 apps/web/assets/pwa-icon.svg（不随站点发布），重新生成见 ADR-013。
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash()),
  },
  // dev 下 `/src/sw.ts` 作为模块 SW 加载，会静态 import workbox：预打包以避免裸模块解析问题
  optimizeDeps: {
    include: [
      'workbox-precaching',
      'workbox-routing',
      'workbox-strategies',
      'workbox-expiration',
      'workbox-cacheable-response',
    ],
  },
  server: {
    port: 5173,
    host: true,
    strictPort: false,
    proxy: {
      // 开发期把 /api 与音频代理请求转发到 Hono 后端，
      // 从而规避浏览器直连网易云的 CORS 与 http 混合内容问题。
      '/api': { target: API_TARGET, changeOrigin: true },
      '/stream': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: '../server/dist/client',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
})
