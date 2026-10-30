import { test, expect, type Page } from '@playwright/test'

/**
 * E2E：内容区滚动位置按历史条目恢复。
 *
 * 用「库 · 专辑」页（只读本地收藏的专辑，无需联网）种入一批专辑造出可滚动列表，
 * 验证「下钻 → 返回」会恢复原滚动位置。
 */

const IDB_DB = 'pterosaur'
const LIBRARY_KEY = 'pterosaur-library'

/** 向 library store 种入若干收藏专辑（库 · 专辑页据此渲染可滚动列表）。 */
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
            artist: `艺术家 ${i + 1}`,
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
    await page.goto('/library/albums')

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
    await expect(page).toHaveURL(/\/library\/albums/)
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop), { timeout: 3000 })
      .toBeGreaterThan(before - 60)
  })
})

/**
 * 播放岛底部空档（不变量）。
 *
 * 播放岛是悬浮层，不占网格高度；滚动页滚到底时最后一行必须停在岛的上沿之上。
 * 这条留白集中由 styles/app.css 的 `.route-stage >` 规则提供——本用例守住
 * 「新增页面时别把它忘了」（曾经歌单 / 专辑页就漏了）。
 */
test.describe('播放岛底部空档', () => {
  /** 向 library store 种入 N 首收藏曲目（「我喜欢的音乐」据此渲染可滚动列表）。 */
  async function seedFavorites(page: Page, count: number): Promise<void> {
    await page.evaluate(
      ({ db, key, count }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(db)
          req.onupgradeneeded = () => {
            const d = req.result
            if (!d.objectStoreNames.contains('library'))
              d.createObjectStore('library')
          }
          req.onsuccess = () => {
            const d = req.result
            const favorites = Array.from({ length: count }, (_, i) => ({
              source: 'netease',
              id: String(i + 1),
              title: `歌曲 ${i + 1}`,
              artist: `艺术家 ${i + 1}`,
              album: `专辑 ${i + 1}`,
              cover: '',
              duration: 180,
              fee: 'free',
            }))
            const tx = d.transaction('library', 'readwrite')
            tx.objectStore('library').put(
              { state: { favorites }, version: 0 },
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

  test('详情页滚到底时最后一行不被播放岛压住', async ({ page }) => {
    await page.goto('/')
    await seedFavorites(page, 80)
    await page.goto('/favorites')

    const rows = page.locator('.track-row')
    await expect(rows.first()).toBeVisible({ timeout: 10000 })

    // 内容区滚到最底。
    // 注意：内容异步撑高后，useContentScrollRestoration 会在下一帧把滚动位置写回
    // 「该历史条目的记录值」（首次进入为 0），故直接赋值 scrollTop 可能被覆盖——
    // 这里用真实滚轮并轮询确认已到底（用户实际会经历的就是这条路径）。
    const content = page.locator('.app-content')
    await page.mouse.move(640, 400)
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 2000)
    await expect
      .poll(
        () =>
          content.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        { timeout: 5000 },
      )
      .toBeLessThan(2)

    // 末尾空档 ≥ 播放岛高度：最后一行底边停在岛顶之上
    const gap = await page.evaluate(() => {
      const rows = document.querySelectorAll('.track-row')
      const last = rows[rows.length - 1]
      const island = document.querySelector('.playerbar')
      if (!last || !island) return NaN
      return (
        island.getBoundingClientRect().top - last.getBoundingClientRect().bottom
      )
    })
    expect(gap).toBeGreaterThanOrEqual(0)

    // 尾注：`N 项，X 小时 Y 分钟`（80 首 × 3:00 = 240 分钟 = 4 小时 0 分钟）
    await expect(page.locator('.track-list__summary')).toHaveText(
      '共 80 项，4 小时 0 分钟',
    )
  })
})
