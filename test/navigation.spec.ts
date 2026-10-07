import { test, expect, type Page } from '@playwright/test'

/** 等待路由转场彻底结束（`data-route-vt` 摘除）：转场期间合成滚轮事件可能被动画吞掉。 */
async function waitForRouteTransitionEnd(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.documentElement.dataset.routeVt,
    undefined,
    { timeout: 3000 },
  )
}

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

test('搜索页下钻返回后仍处于原分类 tab（tab 进 URL）', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('search-input').fill('周杰伦')
  await page.getByTestId('search-input').press('Enter')
  await page.waitForURL(/\/search/)

  // 切到「艺人」tab：tab 进 URL（replace，不压新历史条目）
  await page.getByRole('tab', { name: '艺人' }).click()
  await expect(page).toHaveURL(/\/search\?.*tab=artists/)

  // 下钻艺人页（push 新条目）→ 返回（POP）：仍处于「艺人」tab 且 URL 保留 tab 参数
  await expect(page.locator('.card--artist').first()).toBeVisible({
    timeout: 15_000,
  })
  await page.locator('.card--artist').first().click()
  await expect(page).toHaveURL(/\/artist\//)
  await page.goBack()
  await expect(page).toHaveURL(/\/search\?.*tab=artists/)
  await expect(page.getByRole('tab', { name: '艺人' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('搜索页：切 tab 后下钻返回恢复该 tab 的滚动位置', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('search-input').fill('周杰伦')
  await page.getByTestId('search-input').press('Enter')
  await page.waitForURL(/\/search/)
  await page.getByRole('tab', { name: '艺人' }).click()
  await expect(page).toHaveURL(/tab=artists/)
  await expect(page.locator('.card--artist').first()).toBeVisible({
    timeout: 15_000,
  })

  const content = page.locator('.app-content')
  await waitForRouteTransitionEnd(page)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 600)
  await page.waitForTimeout(200)
  const before = await content.evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(100)

  await page.locator('.card--artist').first().click()
  await expect(page).toHaveURL(/\/artist\//)
  await page.goBack()
  await expect(page).toHaveURL(/\/search\?.*tab=artists/)
  await expect
    .poll(() => content.evaluate((el) => el.scrollTop), { timeout: 3000 })
    .toBeGreaterThan(before - 60)
})

/** 各 tab 的卡片选择器（歌曲行点击是播放、MV 是播放，均无下钻，不参与本用例）。 */
const TAB_CARDS: Record<string, string> = {
  artists: '.card--artist',
  albums: '.card--album',
  playlists: '.card--playlist',
}

for (const [tabName, cardSelector] of Object.entries(TAB_CARDS)) {
  test(`搜索页：${tabName} tab 下钻返回恢复滚动`, async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('search-input').fill('周杰伦')
    await page.getByTestId('search-input').press('Enter')
    await page.waitForURL(/\/search/)
    await page.getByRole('tab', { name: tabName === 'artists' ? '艺人' : tabName === 'albums' ? '专辑' : '歌单' }).click()
    await expect(page).toHaveURL(new RegExp(`tab=${tabName}`))
    await expect(page.locator(cardSelector).first()).toBeVisible({
      timeout: 15_000,
    })

    const content = page.locator('.app-content')
    await waitForRouteTransitionEnd(page)
    // 滚两段：越过第一页底部，触发懒加载续页（返回时须恢复等量内容，否则滚动被钳回第一页）
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(400)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    const before = await content.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(600)

    await page.locator(cardSelector).first().click()
    await expect(page).toHaveURL(
      new RegExp(`/${tabName.replace(/s$/, '')}/`),
    )
    await page.waitForTimeout(300)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`tab=${tabName}`))
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop), { timeout: 3000 })
      .toBeGreaterThan(before - 60)
  })
}

test('搜索页：tab 间来回切换各自保留滚动位置', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('search-input').fill('周杰伦')
  await page.getByTestId('search-input').press('Enter')
  await page.waitForURL(/\/search/)

  const content = page.locator('.app-content')
  // 专辑 tab 滚一段
  await page.getByRole('tab', { name: '专辑' }).click()
  await expect(page).toHaveURL(/tab=albums/)
  await expect(page.locator('.card--album').first()).toBeVisible({
    timeout: 15_000,
  })
  await waitForRouteTransitionEnd(page)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 500)
  await page.waitForTimeout(200)
  const albumScrolled = await content.evaluate((el) => el.scrollTop)
  expect(albumScrolled).toBeGreaterThan(100)

  // 切去歌曲再切回专辑：应回到专辑 tab 的原滚动位置
  await page.getByRole('tab', { name: '歌曲' }).click()
  await waitForRouteTransitionEnd(page)
  await page.getByRole('tab', { name: '专辑' }).click()
  await expect
    .poll(() => content.evaluate((el) => el.scrollTop), { timeout: 3000 })
    .toBeGreaterThan(albumScrolled - 60)
})
