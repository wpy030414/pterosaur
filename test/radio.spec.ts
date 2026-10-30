import { test, expect } from '@playwright/test'

/**
 * E2E：广播页 = 新发现「歌单已更新」的无限滚动版。
 *
 * 语义（ADR-053）：广播页没有独立的数据源，它的全部内容就是首页「正在更新」那一块
 * 的歌单，只是摊成纵向网格、底部哨兵自动续页。故首页的「更多」必须能跳到这里。
 */
test.describe('广播页', () => {
  test('新发现「歌单已更新」的「更多」跳转广播页', async ({ page }) => {
    await page.goto('/')

    const more = page.getByRole('link', { name: '查看全部歌单已更新' })
    await expect(more).toBeVisible()
    await more.click()

    await expect(page).toHaveURL(/\/radio/)
    await expect(page.locator('.browse__title')).toHaveText('广播')
  })

  test('广播页按「歌单已更新」纵向展示歌单卡', async ({ page }) => {
    await page.goto('/radio')

    // 上游实时取数，给足首屏加载时间
    const cards = page.locator('.card-grid .card')
    await expect(cards.first()).toBeVisible({ timeout: 20_000 })
    expect(await cards.count()).toBeGreaterThan(0)
  })

  test('滚到底自动续页，累积结果不重复', async ({ page }) => {
    await page.goto('/radio')
    const cards = page.locator('.card-grid .card')
    await expect(cards.first()).toBeVisible({ timeout: 20_000 })
    const first = await cards.count()

    // 不断把内容区滚到底，直到新增卡片（续页成功判定）
    await expect
      .poll(
        async () => {
          await page.evaluate(() => {
            const el = document.querySelector('.app-content')
            if (el) el.scrollTop = el.scrollHeight
          })
          return cards.count()
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(first)

    // 跨页去重：以卡片 alt（歌单名）作身份近似，不得重复
    const titles = await cards.evaluateAll((els) =>
      els.map((el) => el.querySelector('img')?.getAttribute('alt') ?? ''),
    )
    expect(new Set(titles).size).toBe(titles.length)
  })
})
