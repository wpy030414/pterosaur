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
 * E2E：浏览器前进 / 后退也走内容区转场。
 *
 * 此前只有「跳转新地址」（push）有转场，popstate 前进 / 后退没有；现由自定义路由器
 * （`components/AppRouter.tsx`）把所有历史变更统一包进 View Transition，并按方向在 `<html>`
 * 上打 `data-route-dir`（`lib/viewTransition.ts` 写入）。这里观察该标记以断言后退走了转场。
 * Chromium 支持 View Transitions，故该路径会被走到。
 *
 * 备注：自 ADR-049 起顶栏已移除，前进 / 后退完全依赖浏览器原生机制；本文件用 `page.goBack()`
 * 触发该路径。
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

/**
 * 进搜索页并提交一个关键词。
 *
 * 顶栏移除后搜索框只在搜索页上（ADR-049），所以所有搜索用例都必须先导航到 /search。
 */
async function searchFor(page: Page, q: string): Promise<void> {
  await page.getByRole('link', { name: '搜索' }).click()
  // 用 toHaveURL 轮询：SPA 内换历史条目不触发文档加载，waitForURL 等不到
  await expect(page).toHaveURL(/\/search/)
  await page.getByTestId('search-input').fill(q)
  await page.getByTestId('search-input').press('Enter')
  await expect(page).toHaveURL(/\/search\?q=/)
}

const readDirs = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __dirs?: string[] }).__dirs ?? [])

test('浏览器后退走内容区转场（逆放）', async ({ page }) => {
  await page.goto('/')
  await recordRouteDirs(page)

  // 触发一次 SPA 前进导航：首页 → 广播（push 一条新历史）
  await page.getByRole('link', { name: '广播' }).click()
  await expect(page).toHaveURL(/\/radio/)

  // 顶栏前进/后退按钮已随顶栏移除（ADR-049），改用**浏览器原生后退**：
  // 路由器把它们同样包进转场，故方向标记应仍为 back。
  await page.goBack()
  // 用 toHaveURL 轮询而非 waitForURL：popstate 是 SPA 内换历史条目，不触发文档加载，
  // waitForURL 默认等的是 load 型导航（会一直等到超时）。
  await expect(page).toHaveURL((u) => u.pathname === '/')

  await expect.poll(() => readDirs(page)).toContain('back')
})

/** 五条分区滑轨的标题（顺序即页面上的纵向顺序）。 */
const RAIL_TITLES = ['歌曲', '艺术家', '专辑', '歌单', '磁带'] as const

/**
 * E2E：搜索结果的多分区版式（ADR-050）。
 *
 * 搜索页不再有 tab——五类结果各占一条横向滑轨同页展示，滑轨尾部的「更多」进入
 * 独立类别页（`/search/{类别}?q=`），独立页里再纵向哨兵续页。
 */

/** 某条分区滑轨（Rail 的 `h2` 是分区标题）。 */
const railOf = (page: Page, title: string) =>
  page.locator('section.rail', {
    has: page.getByRole('heading', { name: title, exact: true }),
  })

test('搜索结果：五个分区滑轨同页可见，且没有 tab', async ({ page }) => {
  await page.goto('/')
  await searchFor(page, '周杰伦')

  for (const title of RAIL_TITLES) {
    await expect(railOf(page, title)).toHaveCount(1)
  }
  // 纵向顺序：磁带排在歌单之后
  const order = (
    await page.locator('section.rail .rail__title').allTextContents()
  ).map((t) => t.trim())
  expect(order).toEqual([...RAIL_TITLES])
  // 分区内容的形态：歌曲是紧凑曲目行，磁带是 16:9 磁带卡，其余是普通卡片
  await expect(railOf(page, '歌曲').locator('.song-row').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    railOf(page, '磁带').locator('.card--cassette').first(),
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    railOf(page, '艺术家').locator('.card--artist').first(),
  ).toBeVisible({ timeout: 20_000 })

  // 旧的 tab 胶囊已彻底移除
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.locator('.search__tabs')).toHaveCount(0)
})

test('搜索结果：滑轨尾部「更多」进入独立类别页，独立页可滚动续页', async ({
  page,
}) => {
  await page.goto('/')
  await searchFor(page, '周杰伦')

  const songsRail = railOf(page, '歌曲')
  // 预览只给 24 首（4 行 × 6 列），更多藏在「更多」后面
  const previewRows = songsRail.locator('.song-row')
  await expect(previewRows).toHaveCount(24, { timeout: 20_000 })
  const moreLink = songsRail.getByTestId('rail-more')
  await expect(moreLink).toBeVisible({ timeout: 20_000 })
  await moreLink.click()

  await expect(page).toHaveURL(/\/search\/songs\?q=/)
  await expect(page.locator('.track-row').first()).toBeVisible({
    timeout: 20_000,
  })

  // 续页：滚到底部后哨兵触发追加，条目数应增长
  const rows = page.locator('.track-row')
  const before = await rows.count()
  const content = page.locator('.app-content')
  await waitForRouteTransitionEnd(page)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 4000)
  await page.waitForTimeout(600)
  await page.mouse.wheel(0, 4000)
  await page.waitForTimeout(1200)
  await expect
    .poll(async () => rows.count(), { timeout: 15_000 })
    .toBeGreaterThan(before)
  expect(await content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('搜索结果：换词后五个分区刷新为新词，不残留旧结果（回归）', async ({
  page,
}) => {
  await page.goto('/')
  await searchFor(page, '周杰伦')
  const firstBefore = await railOf(page, '歌曲')
    .locator('.song-row')
    .first()
    .textContent()

  await page.getByTestId('search-input').fill('林俊杰 江南')
  await page.getByTestId('search-input').press('Enter')
  await expect(page).toHaveURL(/q=/)
  await expect(railOf(page, '歌曲').locator('.song-row').first()).toBeVisible({
    timeout: 20_000,
  })
  const firstAfter = await railOf(page, '歌曲')
    .locator('.song-row')
    .first()
    .textContent()
  expect(firstAfter).not.toBe(firstBefore)
  // 旧版 tab 参数不再出现
  await expect(page).not.toHaveURL(/tab=/)
})

test('搜索结果：旧深链上的 ?tab= 被忽略，五分区照常展示', async ({ page }) => {
  await page.goto('/search?q=' + encodeURIComponent('周杰伦') + '&tab=cassette')
  for (const title of RAIL_TITLES) {
    await expect(railOf(page, title)).toHaveCount(1)
  }
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('独立类别页续页不产生重复 key 警告（去重回归）', async ({ page }) => {
  // 上游分页会**跨页返回同一实体**（实测 B 站第 1、2 页都含同一 bvid）；
  // 独立页把多页累积成一个列表，重复项会让 React 报重复 key、旧卡片残留在 DOM 里。
  const dupKeyWarnings: string[] = []
  page.on('console', (m) => {
    if (/same key|non-unique keys/i.test(m.text()))
      dupKeyWarnings.push(m.text().slice(0, 120))
  })

  await page.goto('/search/cassette?q=' + encodeURIComponent('周杰伦'))
  await expect(page.locator('.card--cassette').first()).toBeVisible({
    timeout: 25_000,
  })

  await waitForRouteTransitionEnd(page)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(800)
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(1500)

  expect(dupKeyWarnings).toEqual([])

  // 同一身份键在列表里不得重复出现（磁带 = Playlist，取卡片 a11y 名称去重计数）
  const names = await page
    .locator('.card--cassette')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''))
  expect(new Set(names).size).toBe(names.length)
})
