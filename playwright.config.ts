import { defineConfig, devices } from '@playwright/test'

const API_PORT = process.env.API_PORT ?? '8788'
const WEB_PORT = Number(process.env.E2E_PORT ?? 4173)

/**
 * E2E 测试面向「生产形态」运行：先构建前端，再由 Hono 服务同时提供 SPA 与 API，
 * 与线上 https 服务器的部署形态一致（单一同源，无 CORS / 混合内容问题）。
 */
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 本套 E2E 依赖实时网易云：偶发限流（405「操作频繁」）会让搜索类用例抖动，故本地与 CI 均开启重试。
  retries: 2,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /*
     * 无动画偏好：应用对此有完整适配（styles/global.css 的 prefers-reduced-motion 块，
     * 含 `scroll-behavior: auto`），滚动 / 转场瞬时完成——否则 smooth 滚动与页面转场
     * 会让「滚到底」「元素位置」类断言在动画中途取到中间态。
     */
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // PTEROSAUR_RIP_FAKE_BURN：翻录 E2E 的模拟刻录缝（探测 / 取流 / 刻录全模拟，
    // 无光驱环境全链路封闭；见 ADR-048）。仅影响 /api/rip/* 与实体刻录任务。
    command: `pnpm build && cross-env NODE_ENV=production PTEROSAUR_RIP_FAKE_BURN=1 PORT=${WEB_PORT} API_PORT=${API_PORT} pnpm start`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
