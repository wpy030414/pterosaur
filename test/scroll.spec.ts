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
 * 播放岛是悬浮层，不占网格高度；滚动页滚到底时**最后一项内容**必须停在岛的上沿之上。
 * 这条留白由 styles/app.css 的 `.route-stage >` 规则一次性覆盖**每条路由的根节点**，
 * 不按页面类名枚举——本用例遍历全部离线可构造的页面守住这一点
 * （曾经库页漏配、首页 / 电台 / 歌单页被自身的 `padding` 简写压掉）。
 */
test.describe('播放岛底部空档', () => {
  /** 向 library store 种入各页面所需数据（曲目 / 专辑 / 艺术家），造出可滚动列表。 */
  async function seedLibrary(page: Page): Promise<void> {
    await page.evaluate(
      ({ db, key }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(db)
          req.onupgradeneeded = () => {
            const d = req.result
            if (!d.objectStoreNames.contains('library'))
              d.createObjectStore('library')
          }
          req.onsuccess = () => {
            const d = req.result
            const rows = (n: number, mk: (i: number) => object) =>
              Array.from({ length: n }, (_, i) => mk(i + 1))
            const tx = d.transaction('library', 'readwrite')
            tx.objectStore('library').put(
              {
                state: {
                  favorites: rows(80, (i) => ({
                    source: 'netease',
                    id: String(i),
                    title: `歌曲 ${i}`,
                    artist: `艺术家 ${i}`,
                    album: `专辑 ${i}`,
                    cover: '',
                    duration: 180,
                    fee: 'free',
                  })),
                  savedAlbums: rows(80, (i) => ({
                    source: 'netease',
                    id: String(i),
                    name: `专辑 ${i}`,
                    cover: '',
                    artist: `艺术家 ${i}`,
                  })),
                  savedArtists: rows(80, (i) => ({
                    source: 'netease',
                    id: String(i),
                    name: `艺术家 ${i}`,
                    avatar: '',
                  })),
                },
                version: 0,
              },
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
      { db: IDB_DB, key: LIBRARY_KEY },
    )
  }

  /**
   * 滚到内容区最底，返回到达底部后的空档：
   * - `slack`：最后一个叶子元素底边 → 内容区**内容盒**底边（页面为播放岛让出的留白）；
   * - `visualGap`：最后一个叶子元素底边 → 播放岛胶囊顶边（用户实际看到的空隙）。
   *
   * 只看**叶子元素**：中间层容器（页面根、栅格、轨道）会被拉伸或被伪元素撑高，
   * 量它们的底边只会得到「岛高」的恒定负值。
   */
  async function bottomMetrics(page: Page) {
    /*
     * 内容异步撑高（首页 / 发现流逐块加载），一次赋值可能只是「当时」的底部。
     * 反复滚到底直到 scrollTop 稳定——既覆盖了 useContentScrollRestoration
     * 布局期回写位置的时机，也覆盖了内容后续撑高。
     */
    const reached = await page.locator('.app-content').evaluate(async (el) => {
      const prev = el.style.scrollBehavior
      el.style.scrollBehavior = 'auto'
      let last = -1
      for (let i = 0; i < 40; i++) {
        el.scrollTop = el.scrollHeight
        if (
          el.scrollTop === last &&
          el.scrollHeight - el.scrollTop <= el.clientHeight + 1
        )
          break
        last = el.scrollTop
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))
      }
      el.style.scrollBehavior = prev
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    expect(reached).toBeLessThanOrEqual(1)

    return page.evaluate(() => {
      const content = document.querySelector('.app-content') as HTMLElement
      const stage = document.querySelector('.route-stage')!
      const island = document.querySelector('.playerbar__dock')!
      const cs = getComputedStyle(content)
      const contentBoxBottom =
        content.getBoundingClientRect().bottom -
        parseFloat(cs.paddingBottom) -
        parseFloat(cs.borderBottomWidth)

      let leaf = -Infinity
      for (const el of stage.querySelectorAll('*')) {
        if (el.childElementCount > 0) continue
        const r = el.getBoundingClientRect()
        if (r.width && r.height && getComputedStyle(el).position !== 'fixed')
          leaf = Math.max(leaf, r.bottom)
      }
      return {
        // 内容区底部与播放岛顶边的距离：留白至少要盖住这一段，最后一行才不被压住
        islandReach: contentBoxBottom - island.getBoundingClientRect().top,
        slack: contentBoxBottom - leaf,
        visualGap: island.getBoundingClientRect().top - leaf,
      }
    })
  }

  // 全部离线可构造的页面（无需上游音源）。
  const PAGES = [
    ['我喜欢的音乐', '/favorites'],
    ['库 · 专辑', '/library/albums'],
    ['库 · 艺术家', '/library/artists'],
    ['广播', '/radio'],
    ['发现（首页）', '/'],
  ] as const

  for (const [name, path] of PAGES) {
    test(`${name}滚到底时最后一行不被播放岛压住`, async ({ page }) => {
      await page.goto('/')
      await seedLibrary(page)
      await page.goto(path)
      await expect(page.locator('.route-stage > *').first()).toBeVisible({
        timeout: 10000,
      })

      const { islandReach, slack, visualGap } = await bottomMetrics(page)
      expect(islandReach).toBeGreaterThan(0)
      // 留白盖住播放岛占用的那一段，最后一行才停在胶囊之上
      expect(slack).toBeGreaterThanOrEqual(islandReach - 1)
      expect(visualGap).toBeGreaterThanOrEqual(-1)
    })
  }

  test('尾注：N 项与总时长', async ({ page }) => {
    await page.goto('/')
    await seedLibrary(page)
    await page.goto('/favorites')
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 10000,
    })

    // 80 首 × 3:00 = 240 分钟 = 4 小时 0 分钟
    await expect(page.locator('.track-list__summary')).toHaveText(
      '共 80 项，4 小时 0 分钟',
    )
  })
})
