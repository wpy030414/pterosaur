import { test, expect, type Page } from '@playwright/test'

/**
 * E2E：顶栏前进 / 后退按钮也走内容区转场。
 *
 * 此前只有「跳转新地址」（push）有转场，popstate 前进 / 后退没有；现由自定义路由器
 * （`components/AppRouter.tsx`）把所有历史变更统一包进 View Transition，并按方向在 `<html>`
 * 上打 `data-route-dir`（`lib/viewTransition.ts` 写入）。这里观察该标记以断言后退走了转场。
 * Chromium 支持 View Transitions，故该路径会被走到。
 */

/** 安装观察器，记录每次转场的方向标记（`data-route-dir` 属瞬态，需在变更时即记录）。 */
async function recordRouteDirs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __dirs?: string[] }
    w.__dirs = []
    new MutationObserver(() => {
      const d = document.documentElement.getAttribute('data-route-dir')
      if (d) w.__dirs?.push(d)
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-route-dir'],
    })
  })
}

const readDirs = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __dirs?: string[] }).__dirs ?? [])

test('顶栏后退导航走内容区转场（逆放）', async ({ page }) => {
  await page.goto('/')
  await recordRouteDirs(page)

  // 触发一次 SPA 前进导航（搜索）
  await page.getByTestId('search-input').fill('pterosaur')
  await page.getByTestId('search-input').press('Enter')
  await page.waitForURL(/\/search/)

  // 顶栏后退 → 应走一次「后退」方向的转场
  await page.getByRole('button', { name: '后退' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/search'))

  await expect.poll(() => readDirs(page)).toContain('back')
})
