import { test, expect, type Page } from '@playwright/test'

/**
 * E2E：内容区滚动位置按历史条目恢复。
 *
 * 用「唱片盒」（只读本地收藏的专辑，无需联网）种入一批专辑造出可滚动列表，
 * 验证「下钻 → 返回」会恢复原滚动位置。
 */

const IDB_DB = 'pterosaur'
const LIBRARY_KEY = 'pterosaur-library'

/** 向 library store 种入若干收藏专辑（唱片盒据此渲染可滚动列表）。 */
async function seedSavedAlbums(page: Page, count: number): Promise<void> {
  await page.evaluate(
    ({ db, key, count }) =>
      new Promise<void>((resolve, reject) => {
        // 不指定版本：库已由应用以最新版本（含 background store）建好，指定旧版本会 VersionError
        const req = indexedDB.open(db)
        req.onupgradeneeded = () => {
          const d = req.result
          if (!d.objectStoreNames.contains('library'))
            d.createObjectStore('library')
        }
        req.onsuccess = () => {
          const d = req.result
          const savedAlbums = Array.from({ length: count }, (_, i) => ({
            source: 'netease',
            id: String(i + 1),
            name: `专辑 ${i + 1}`,
            cover: '',
            artist: `艺人 ${i + 1}`,
          }))
          const tx = d.transaction('library', 'readwrite')
          tx.objectStore('library').put(
            { state: { savedAlbums }, version: 0 },
            key,
          )
          tx.oncomplete = () => {
            d.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    { db: IDB_DB, key: LIBRARY_KEY, count },
  )
}

test.describe('内容区滚动位置', () => {
  test('下钻后返回恢复滚动位置', async ({ page }) => {
    await page.goto('/')
    await seedSavedAlbums(page, 80)
    await page.goto('/crate')

    const content = page.locator('.app-content')
    await expect(page.locator('.card--album').first()).toBeVisible({
      timeout: 10000,
    })

    // 把内容区滚下去（真实滚轮事件）
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(150)
    const before = await content.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(100)

    // 下钻到专辑页（push 新条目）——点一张**当前视野内**的卡片，避免点自动滚屏把位置带偏
    const idx = await page.evaluate(() => {
      const vh = window.innerHeight
      const cards = [...document.querySelectorAll('.card--album')]
      return cards.findIndex((c) => {
        const r = c.getBoundingClientRect()
        return r.top > 80 && r.bottom < vh - 80
      })
    })
    expect(idx).toBeGreaterThanOrEqual(0)
    await page.locator('.card--album').nth(idx).click()
    await expect(page).toHaveURL(/\/album\//)
    await expect(page.locator('.detail').first()).toBeVisible({
      timeout: 10000,
    })

    // 返回（POP）→ 恢复原滚动位置
    await page.goBack()
    await expect(page).toHaveURL(/\/crate/)
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop), { timeout: 3000 })
      .toBeGreaterThan(before - 60)
  })
})
