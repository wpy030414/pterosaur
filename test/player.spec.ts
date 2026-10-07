import { test, expect, type Page } from '@playwright/test'

/**
 * E2E 冒烟：应用外壳与首屏。
 *
 * 面向生产形态（Hono 同源提供 SPA + API），与线上部署一致。
 */

const FREE_SONG_KEYWORD = '陈奕迅 我们'

/** 读取 audio 元素运行时状态。 */
async function audioState(page: Page) {
  return page.evaluate(() => {
    const a = document.querySelector('audio') as HTMLAudioElement | null
    if (!a) return { exists: false }
    return {
      exists: true,
      paused: a.paused,
      currentTime: a.currentTime,
      duration: a.duration,
      readyState: a.readyState,
      errorCode: a.error?.code ?? null,
      src: a.currentSrc,
    }
  })
}

// —— IndexedDB 辅助：library 已从 localStorage 迁到 IDB，种入/清理/等待都走 IDB ——

const IDB_DB = 'pterosaur'
const IDB_STORE = 'library'
const LIBRARY_KEY = 'pterosaur-library'

/** 种入 library 状态（等待事务完成，规避异步竞态）。 */
async function seedLibrary(
  page: Page,
  state: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ db, store, key, value }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(db)
        req.onupgradeneeded = () => {
          const d = req.result
          if (!d.objectStoreNames.contains('library'))
            d.createObjectStore('library')
          if (!d.objectStoreNames.contains('media'))
            d.createObjectStore('media')
          if (!d.objectStoreNames.contains('mediaMeta')) {
            const m = d.createObjectStore('mediaMeta', { keyPath: 'key' })
            m.createIndex('lastAccess', 'lastAccess')
          }
        }
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction(store, 'readwrite')
          tx.objectStore(store).put(value, key)
          tx.oncomplete = () => {
            d.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    {
      db: IDB_DB,
      store: IDB_STORE,
      key: LIBRARY_KEY,
      value: { state, version: 0 },
    },
  )
}

/** 清空 library 记录（保证空态）。 */
async function clearLibrary(page: Page): Promise<void> {
  await page.evaluate(
    ({ db, store, key }) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open(db)
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction(store, 'readwrite')
          tx.objectStore(store).delete(key)
          tx.oncomplete = () => {
            d.close()
            resolve()
          }
          tx.onerror = () => {
            d.close()
            resolve()
          }
        }
        req.onerror = () => resolve()
      }),
    { db: IDB_DB, store: IDB_STORE, key: LIBRARY_KEY },
  )
}

/** 轮询等待 library 的某个字段已落盘（异步 IDB 持久化，硬跳转/reload 前需确定性等待）。 */
async function waitForLibraryPersisted(
  page: Page,
  field: 'favorites' | 'savedAlbums' | 'savedArtists' = 'favorites',
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ db, store, key, field }) =>
            new Promise<number>((resolve) => {
              const req = indexedDB.open(db)
              req.onsuccess = () => {
                const d = req.result
                const tx = d.transaction(store, 'readonly')
                const g = tx.objectStore(store).get(key)
                g.onsuccess = () => {
                  d.close()
                  const v = g.result as
                    { state?: Record<string, unknown[]> } | undefined
                  resolve(v?.state?.[field]?.length ?? 0)
                }
                g.onerror = () => {
                  d.close()
                  resolve(0)
                }
              }
              req.onerror = () => resolve(0)
            }),
          { db: IDB_DB, store: IDB_STORE, key: LIBRARY_KEY, field },
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0)
}

test.describe('应用外壳', () => {
  test('首页加载并渲染侧栏、问候与推荐歌单', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Pterosaur')).toBeVisible()
    await expect(page.locator('.home__greeting')).toBeVisible()

    // 推荐卡片应在数秒内加载（依赖后端 -> 网易云）
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })
    const cardCount = await page.locator('.card').count()
    expect(cardCount).toBeGreaterThan(0)
  })

  test('侧栏导航可在主要页面间跳转', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: '浏览' }).click()
    await expect(page).toHaveURL(/\/browse/)
    await expect(
      page.locator('.browse__title', { hasText: '浏览' }),
    ).toBeVisible()

    await page.getByRole('link', { name: '电台' }).click()
    await expect(page).toHaveURL(/\/radio/)

    await page.getByRole('link', { name: '我喜欢的音乐' }).click()
    await expect(page).toHaveURL(/\/favorites/)

    // 「唱片盒」入口
    await page.getByRole('link', { name: '唱片盒' }).click()
    await expect(page).toHaveURL(/\/crate/)
    await expect(page.locator('.crate__title')).toBeVisible()

    await page.getByRole('link', { name: '立即收听' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('立即收听：点击快捷入口本体进入对应页面（而非播放）', async ({
    page,
  }) => {
    await page.goto('/')
    // 种入一条收藏与一条最近播放，确认「有内容」时点击本体也走导航而非播放
    const t = {
      source: 'netease',
      id: 'seed-1',
      title: '种子曲目',
      artist: '艺人',
      album: '专辑',
      cover: '',
      duration: 200,
      fee: 'free',
    }
    await seedLibrary(page, {
      favorites: [t],
      recent: [t],
      playlists: [],
      savedPlaylists: [],
      savedAlbums: [],
    })
    await page.reload()
    await expect(page.locator('.home__shortcuts')).toBeVisible({
      timeout: 15000,
    })

    await page.locator('.shortcut', { hasText: '我喜欢的音乐' }).click()
    await expect(page).toHaveURL(/\/favorites/)

    await page.goto('/')
    await expect(page.locator('.home__shortcuts')).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.shortcut', { hasText: '最近播放' }).click()
    await expect(page).toHaveURL(/\/recent/)

    // 全程未触发播放（audio 仍处于暂停）
    const paused = await page.evaluate(
      () => (document.querySelector('audio') as HTMLAudioElement).paused,
    )
    expect(paused).toBe(true)
  })

  test('立即收听：快捷入口的播放按钮直接播放，不跳转', async ({ page }) => {
    await page.goto('/')
    const t = {
      source: 'netease',
      id: 'seed-1',
      title: '种子曲目',
      artist: '艺人',
      album: '专辑',
      cover: '',
      duration: 200,
      fee: 'free',
    }
    await seedLibrary(page, {
      favorites: [t],
      recent: [t],
      playlists: [],
      savedPlaylists: [],
      savedAlbums: [],
    })
    await page.reload()
    await expect(page.locator('.home__shortcuts')).toBeVisible({
      timeout: 15000,
    })

    await page
      .getByRole('button', { name: '播放我喜欢的音乐', exact: true })
      .click()

    // 未跳转，且底栏出现曲名（已进入播放态）
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('.playerbar__title')).not.toBeEmpty({
      timeout: 8000,
    })
  })

  test('立即收听：集合为空时 hover 仍出现播放按钮（禁用态）', async ({
    page,
  }) => {
    await page.goto('/')
    await clearLibrary(page)
    await page.reload()
    await expect(page.locator('.home__shortcuts')).toBeVisible({
      timeout: 15000,
    })

    const play = page.getByRole('button', {
      name: '播放我喜欢的音乐',
      exact: true,
    })
    // 空集合：按钮存在但禁用
    await expect(play).toBeDisabled()

    // hover 后浮现（opacity 由 0 变为 1）
    await page.locator('.shortcut', { hasText: '我喜欢的音乐' }).hover()
    await expect
      .poll(async () =>
        Number(await play.evaluate((el) => getComputedStyle(el).opacity)),
      )
      .toBeGreaterThan(0.5)
  })

  test('侧边栏标题点击切换 commit 哈希，GitHub 图标指向仓库', async ({
    page,
  }) => {
    await page.goto('/')
    const brand = page.locator('.sidebar__name')
    await expect(brand).toHaveText('Pterosaur')

    // 点击一次 → 显示 commit 短哈希（7 位十六进制；非 git 构建回退为 dev）
    await brand.click()
    await expect(brand).toHaveText(/^([0-9a-f]{7}|dev)$/)

    // 再点一次 → 恢复品牌名
    await brand.click()
    await expect(brand).toHaveText('Pterosaur')

    // GitHub 图标：指向仓库且新窗口打开
    const gh = page.locator('.sidebar__github')
    await expect(gh).toHaveAttribute('href', /^https:\/\/github\.com\/.+/)
    await expect(gh).toHaveAttribute('target', '_blank')
  })

  test('主题切换在明暗之间生效', async ({ page }) => {
    await page.goto('/')
    const root = page.locator('html')

    // 点击主题按钮（aria-label 为「切换到浅色」或「切换到深色」）
    const toggle = page
      .locator(
        'button[aria-label="切换到浅色"], button[aria-label="切换到深色"]',
      )
      .first()
    const before = await root.getAttribute('data-theme')
    await toggle.click()
    await expect
      .poll(async () => root.getAttribute('data-theme'), { timeout: 3000 })
      .not.toBe(before === null ? 'system' : before)
    // 主题转场的根标记最终应清除（不残留，否则会一直开着根快照）
    await expect(root).not.toHaveAttribute('data-theme-vt', 'on')
  })

  test('减少动效下主题切换仍生效且不走转场', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    const root = page.locator('html')

    const toggle = page
      .locator(
        'button[aria-label="切换到浅色"], button[aria-label="切换到深色"]',
      )
      .first()
    const before = await root.getAttribute('data-theme')
    await toggle.click()
    await expect
      .poll(async () => root.getAttribute('data-theme'), { timeout: 3000 })
      .not.toBe(before === null ? 'system' : before)
    // 减少动效：直连切换，不应设转场标记
    await expect(root).not.toHaveAttribute('data-theme-vt', 'on')
  })
})

test.describe('搜索与播放', () => {
  test('搜索关键词并展示结果行', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('search-input').fill(FREE_SONG_KEYWORD)
    await page.getByTestId('search-input').press('Enter')
    await expect(page).toHaveURL(/\/search\?q=/)

    // 结果行应出现
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    const rows = await page.locator('.track-row').count()
    expect(rows).toBeGreaterThan(0)
  })

  test('浏览磁带后换词：结果刷新为新词，不残留上一个查询（回归）', async ({
    page,
  }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    const firstBefore = await page
      .locator('.col-title__name')
      .first()
      .textContent()

    // 切到磁带 tab，点进一盘磁带再返回——触发搜索页重挂 + 会话级缓存恢复
    await page.getByRole('tab', { name: '磁带' }).click()
    await expect(page.locator('.card--cassette').first()).toBeVisible({
      timeout: 20000,
    })
    await page.locator('.card--cassette').first().click()
    await expect(page).toHaveURL(/\/playlist\/bilibili\//, { timeout: 15000 })
    await page.goBack()
    await expect(page.locator('.card--cassette').first()).toBeVisible({
      timeout: 15000,
    })

    // 换词：应刷新为新词结果（并回到「歌曲」tab），而非残留旧词 / 旧磁带
    await page.getByTestId('search-input').fill('周杰伦 晴天')
    await page.getByTestId('search-input').press('Enter')
    await expect(page).not.toHaveURL(/tab=cassette/)
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('.card--cassette')).toHaveCount(0)
    const firstAfter = await page
      .locator('.col-title__name')
      .first()
      .textContent()
    expect(firstAfter).not.toBe(firstBefore)
  })

  test('点击结果行开始真实播放（audio 未暂停且时间前进）', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })

    await page.locator('.track-row').first().click()

    // 等待音频真正开始：readyState 足够且未暂停
    await expect
      .poll(
        async () => {
          const s = await audioState(page)
          return (
            s.exists && !s.paused && s.readyState >= 2 && s.errorCode === null
          )
        },
        { timeout: 20000, message: '音频应开始播放' },
      )
      .toBe(true)

    // 进度应随时间前进
    const t1 = (await audioState(page)).currentTime
    await page.waitForTimeout(1500)
    const t2 = (await audioState(page)).currentTime
    expect(t2).toBeGreaterThan(t1)

    // 播放条显示当前曲目
    await expect(page.locator('.playerbar__title')).not.toBeEmpty()
  })

  test('播放/暂停按钮切换播放状态', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    await expect
      .poll(async () => (await audioState(page)).paused === false, {
        timeout: 20000,
      })
      .toBe(true)

    // 暂停
    await page.getByTestId('play-toggle').click()
    await expect
      .poll(async () => (await audioState(page)).paused, { timeout: 5000 })
      .toBe(true)

    // 再播放
    await page.getByTestId('play-toggle').click()
    await expect
      .poll(async () => (await audioState(page)).paused === false, {
        timeout: 5000,
      })
      .toBe(true)
  })

  test('下一首切换当前曲目', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()
    await expect
      .poll(async () => (await audioState(page)).paused === false, {
        timeout: 20000,
      })
      .toBe(true)

    const titleBefore = await page.locator('.playerbar__title').textContent()
    await page.getByRole('button', { name: '下一首' }).click()
    await expect
      .poll(async () => page.locator('.playerbar__title').textContent(), {
        timeout: 8000,
      })
      .not.toBe(titleBefore)
  })
})

test.describe('全屏播放页与歌词', () => {
  test('展开播放页显示歌词并可 Esc 关闭', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()
    await expect(page.locator('.nowplaying')).toHaveCount(0)

    // 通过封面按钮展开
    await page.locator('.playerbar__cover-btn').click()
    await expect(page.locator('.nowplaying')).toBeVisible({ timeout: 5000 })

    // 歌词应加载（该曲目有词）
    await expect(page.locator('.lyric-line').first()).toBeVisible({
      timeout: 15000,
    })
    const lines = await page.locator('.lyric-line').count()
    expect(lines).toBeGreaterThan(0)

    // Esc 关闭
    await page.keyboard.press('Escape')
    await expect(page.locator('.nowplaying')).toHaveCount(0, { timeout: 3000 })
  })

  test('沉浸页的专辑 / 歌手可点击跳转', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()
    await page.locator('.playerbar__cover-btn').click()
    await expect(page.locator('.nowplaying')).toBeVisible({ timeout: 5000 })

    // 歌手名可点 → 跳转艺人页，且沉浸页自动收起
    const artistLink = page
      .locator('.nowplaying__artist .nowplaying__link')
      .first()
    await expect(artistLink).toBeVisible({ timeout: 15000 })
    await artistLink.click()
    await expect(page).toHaveURL(/\/artist\//)
    await expect(page.locator('.nowplaying')).toHaveCount(0, { timeout: 3000 })

    // 再次展开：专辑名同样可点 → 跳转专辑页
    await page.locator('.playerbar__cover-btn').click()
    await expect(page.locator('.nowplaying')).toBeVisible({ timeout: 5000 })
    const albumLink = page
      .locator('.nowplaying__header-title .nowplaying__link')
      .first()
    await expect(albumLink).toBeVisible({ timeout: 5000 })
    await albumLink.click()
    await expect(page).toHaveURL(/\/album\//)
  })

  test('首行 / 末行歌词同样垂直居中', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()
    await page.locator('.playerbar__cover-btn').click()
    await expect(
      page.locator('.nowplaying__lyrics .lyric-line').first(),
    ).toBeVisible({ timeout: 15000 })

    // 当前高亮行中心与歌词区中心之差（px）
    const centerDelta = () =>
      page.evaluate(() => {
        const el = document.querySelector('.nowplaying__lyrics')
        const line = el?.querySelector('.lyric-line--active')
        if (!el || !line) return 9999
        const c = el.getBoundingClientRect()
        const l = line.getBoundingClientRect()
        return l.top + l.height / 2 - (c.top + c.height / 2)
      })

    const clickLine = (i: number) =>
      page.evaluate((idx) => {
        const lines = document.querySelectorAll(
          '.nowplaying__lyrics .lyric-line',
        )
        ;(
          lines[Math.min(Math.max(idx, 0), lines.length - 1)] as HTMLElement
        ).click()
      }, i)

    const count = await page.locator('.nowplaying__lyrics .lyric-line').count()

    // 首行（无法靠「滚动」贴到中线，需靠容器内边距）
    await clickLine(0)
    await expect
      .poll(async () => Math.abs(await centerDelta()), { timeout: 3000 })
      .toBeLessThan(3)

    // 末行
    await clickLine(count - 1)
    await expect
      .poll(async () => Math.abs(await centerDelta()), { timeout: 3000 })
      .toBeLessThan(3)
  })

  test('共享元素：展开 / 收起时封面持名互斥', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()
    await expect(page.locator('.nowplaying')).toHaveCount(0)

    // 读取两侧封面的 view-transition-name（大封面 / 底部小封面）
    const names = () =>
      page.evaluate(() => {
        const np = document.querySelector('.nowplaying__cover')
        const pb = document.querySelector('.playerbar__cover-btn .cover')
        return {
          np: np ? getComputedStyle(np).viewTransitionName : null,
          pb: pb ? getComputedStyle(pb).viewTransitionName : null,
        }
      })

    await page.locator('.playerbar__cover-btn').click()
    await expect(page.locator('.nowplaying')).toBeVisible({ timeout: 5000 })

    // 展开后：大封面持 np-cover，底部小封面让名（二者绝不同时持名）
    await expect
      .poll(async () => (await names()).np, { timeout: 3000 })
      .toBe('np-cover')
    expect((await names()).pb).not.toBe('np-cover')

    // 收起（Esc）后：小封面重新持名
    await page.keyboard.press('Escape')
    await expect(page.locator('.nowplaying')).toHaveCount(0, { timeout: 3000 })
    await expect
      .poll(async () => (await names()).pb, { timeout: 3000 })
      .toBe('np-cover')
  })

  test('减少动效下开合仍然可用且无报错', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })

    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    await page.locator('.playerbar__cover-btn').click()
    await expect(page.locator('.nowplaying')).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.nowplaying')).toHaveCount(0, { timeout: 3000 })

    expect(errors, errors.join('\n')).toHaveLength(0)
  })
})

test.describe('播放队列', () => {
  test('打开队列面板显示当前队列曲目', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    // 关闭态：面板在屏外，不应带可见投影（实心投影会漏进窗口右缘）
    const closedShadow = await page
      .locator('.queue-panel')
      .evaluate((el) => getComputedStyle(el).boxShadow)
    expect(closedShadow).toContain('rgba(0, 0, 0, 0)')

    await page.getByRole('button', { name: '播放队列' }).click()
    await expect(page.locator('.queue-panel--open')).toBeVisible({
      timeout: 3000,
    })

    // 关闭按钮已移除（改用遮罩 / 播放队列按钮关闭）
    await expect(page.getByRole('button', { name: '关闭队列' })).toHaveCount(0)

    const items = await page.locator('.queue-item').count()
    expect(items).toBeGreaterThan(0)
    // 当前曲目高亮
    await expect(page.locator('.queue-item--active').first()).toBeVisible()
  })
})

test.describe('资料库与收藏', () => {
  test('收藏曲目后出现在「我喜欢的音乐」并持久化', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })

    const firstTitle = await page
      .locator('.track-row .col-title__name')
      .first()
      .textContent()

    // 悬停行后点击「喜欢」
    const firstRow = page.locator('.track-row').first()
    await firstRow.hover()
    await firstRow.getByRole('button', { name: '喜欢' }).first().click()
    // 持久化是异步的（IndexedDB）：硬跳转前先等写入落盘，避免与导航竞态
    await waitForLibraryPersisted(page)

    // 进入收藏页
    await page.goto('/favorites')
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 8000,
    })
    await expect(page.locator('.track-row').first()).toContainText(
      (firstTitle ?? '').trim(),
    )

    // 刷新后仍在（IndexedDB 持久化）
    await page.reload()
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 8000,
    })
    await expect(page.locator('.track-row').first()).toContainText(
      (firstTitle ?? '').trim(),
    )
  })

  test('空收藏时显示空状态', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/favorites')
    // 清空 IndexedDB 中的 library 以确保空态（可能因上一用例留有数据）
    await clearLibrary(page)
    await page.reload()
    await expect(page.getByText('还没有喜欢的音乐')).toBeVisible({
      timeout: 8000,
    })
  })

  test('收藏专辑后出现在唱片盒', async ({ page }) => {
    // 从搜索的专辑 tab 进入一张专辑
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await page.getByRole('tab', { name: /专辑/ }).click()
    await expect(page.locator('.card--album').first()).toBeVisible({
      timeout: 8000,
    })
    const name = (
      (await page.locator('.card--album .card__title').first().textContent()) ??
      ''
    ).trim()

    await page.locator('.card--album').first().click()
    await expect(page).toHaveURL(/\/album\/[^/]+\/\d+/, { timeout: 8000 })
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })

    // 收藏
    await page.getByRole('button', { name: '收藏到资料库' }).click()
    await expect(page.getByRole('button', { name: '取消收藏' })).toBeVisible()
    await waitForLibraryPersisted(page, 'savedAlbums')

    // 唱片盒中出现该专辑
    await page.goto('/crate')
    await expect(page.locator('.crate__title')).toHaveText('唱片盒')
    await expect(page.locator('.crate .card--album').first()).toContainText(
      name,
    )
  })

  test('唱片盒：艺人 / 专辑上下两区；取消收藏后卡片不立即消失', async ({
    page,
  }) => {
    // 本地种入，零联网（规避网易云限流抖动）
    await page.goto('/')
    await seedLibrary(page, {
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedArtists: [
        { source: 'netease', id: 'ar1', name: '测试艺人', avatar: '' },
      ],
      savedAlbums: [
        {
          source: 'netease',
          id: 'a1',
          name: '测试专辑',
          cover: '',
          artist: '甲',
        },
      ],
    })
    await page.goto('/crate')

    // 上下两个分区
    await expect(
      page.locator('.crate .section-title', { hasText: '艺人' }),
    ).toBeVisible()
    await expect(
      page.locator('.crate .section-title', { hasText: '专辑' }),
    ).toBeVisible()
    await expect(page.locator('.crate .card--artist').first()).toContainText(
      '测试艺人',
    )
    await expect(page.locator('.crate .card--album').first()).toContainText(
      '测试专辑',
    )

    // 悬浮艺人卡片 → 取消收藏：红心转为未收藏态，但卡片**不立即消失**（防误触）
    const artistCard = page.locator('.crate .card--artist').first()
    await artistCard.hover()
    await artistCard.getByRole('button', { name: '取消收藏' }).click()
    await expect(page.locator('.crate .card--artist')).toHaveCount(1)
    await expect(
      artistCard.getByRole('button', { name: '收藏到资料库' }),
    ).toBeVisible()

    // 离开再进入（页内跳转，不刷新）→ 才消失；专辑分区不受影响
    await page.getByRole('link', { name: '我喜欢的音乐' }).click()
    await expect(page).toHaveURL(/\/favorites/)
    await page.getByRole('link', { name: '唱片盒' }).click()
    await expect(page).toHaveURL(/\/crate/)
    await expect(page.locator('.crate .card--artist')).toHaveCount(0)
    await expect(page.locator('.crate .card--album').first()).toContainText(
      '测试专辑',
    )
  })

  test('唱片盒空态：未收藏任何艺人 / 专辑时提示去收藏', async ({ page }) => {
    await page.goto('/')
    await clearLibrary(page)
    await page.goto('/crate')
    await expect(page.getByText('唱片盒还空着')).toBeVisible({ timeout: 8000 })
  })

  test('收藏艺人后出现在唱片盒', async ({ page }) => {
    // 借专辑页的艺人链接进入艺人页（复用较稳定的搜索路径）
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await page.getByRole('tab', { name: /专辑/ }).click()
    await expect(page.locator('.card--album').first()).toBeVisible({
      timeout: 8000,
    })
    await page.locator('.card--album').first().click()
    await expect(page).toHaveURL(/\/album\/[^/]+\/\d+/, { timeout: 8000 })

    const artistLink = page.locator('.detail__artist-link').first()
    await expect(artistLink).toBeVisible({ timeout: 8000 })
    await artistLink.click()
    await expect(page).toHaveURL(/\/artist\/[^/]+\/\d+/, { timeout: 8000 })

    // 收藏
    await page.getByRole('button', { name: '收藏到资料库' }).click()
    await expect(page.getByRole('button', { name: '取消收藏' })).toBeVisible()
    await waitForLibraryPersisted(page, 'savedArtists')

    // 唱片盒的艺人分区出现该艺人
    await page.goto('/crate')
    await expect(
      page.locator('.crate .section-title', { hasText: '艺人' }),
    ).toBeVisible({ timeout: 8000 })
    await expect(page.locator('.crate .card--artist').first()).toBeVisible({
      timeout: 8000,
    })
  })
})

test.describe('歌单详情', () => {
  test('从浏览页进入歌单详情并展示曲目', async ({ page }) => {
    await page.goto('/browse')
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })
    await page.locator('.card').first().click()
    await expect(page).toHaveURL(/\/playlist\/[^/]+\/\d+/, { timeout: 8000 })

    await expect(page.locator('.detail__name')).toBeVisible({ timeout: 8000 })
    // 曲目应加载（可能较慢，给足时间）
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })
  })
})

test.describe('卡片播放按钮', () => {
  test('点击卡片播放按钮立即播放，且不进入详情页', async ({ page }) => {
    await page.goto('/browse')
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })

    const card = page.locator('.card').first()
    await card.hover()
    await card.locator('.card__play').click()

    // 仍停留在浏览页（未跳转到歌单详情）
    await expect(page).toHaveURL(/\/browse/)
    // 底栏出现曲名 → 已进入播放态
    await expect(page.locator('.playerbar__title')).not.toBeEmpty({
      timeout: 10000,
    })
  })
})

test.describe('搜索分栏与艺人 / 专辑跳转', () => {
  test('搜索结果分为歌曲 / 磁带 / 艺人 / 专辑 / 歌单五个 tab', async ({
    page,
  }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(5)
    await expect(page.getByRole('tab', { name: /歌曲/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // 默认歌曲 tab：显示曲目行
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })

    // 切到艺人 tab
    await page.getByRole('tab', { name: /艺人/ }).click()
    await expect(page.locator('.card--artist').first()).toBeVisible({
      timeout: 8000,
    })

    // 切到专辑 tab
    await page.getByRole('tab', { name: /专辑/ }).click()
    await expect(page.locator('.card--album').first()).toBeVisible({
      timeout: 8000,
    })
  })

  test('从搜索的艺人卡片进入艺人页', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await page.getByRole('tab', { name: /艺人/ }).click()
    await expect(page.locator('.card--artist').first()).toBeVisible({
      timeout: 8000,
    })

    await page.locator('.card--artist').first().click()
    await expect(page).toHaveURL(/\/artist\/[^/]+\/\d+/, { timeout: 8000 })
    await expect(page.locator('.detail__name')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })
  })

  test('歌单曲目行点击专辑名跳转专辑页', async ({ page }) => {
    // 从浏览页进入任意歌单
    await page.goto('/browse')
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })
    await page.locator('.card').first().click()
    await expect(page).toHaveURL(/\/playlist\/[^/]+\/\d+/, { timeout: 8000 })
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })

    // 点击首行的专辑链接
    await page
      .locator('.track-row')
      .first()
      .locator('.col-album .track-link')
      .click()
    await expect(page).toHaveURL(/\/album\/[^/]+\/\d+/, { timeout: 8000 })
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 20000,
    })
  })
})

test.describe('队列面板毛玻璃', () => {
  test('队列面板具备 backdrop-filter 毛玻璃', async ({ page }) => {
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    await page.getByRole('button', { name: '播放队列' }).click()
    const panel = page.locator('.queue-panel')
    await expect(panel).toHaveClass(/queue-panel--open/)

    const backdrop = await panel.evaluate((el) => {
      const cs = getComputedStyle(el)
      const webkit =
        (cs as unknown as { webkitBackdropFilter?: string })
          .webkitBackdropFilter ?? ''
      return `${cs.backdropFilter ?? ''} ${webkit}`
    })
    expect(backdrop).toContain('blur')
  })
})

test.describe('移动端', () => {
  test('输入框字号 ≥ 16px（避免聚焦时页面被放大）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const size = await page
      .getByTestId('search-input')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(16)
  })

  test('抽屉打开时由侧边栏切换内容，转场不得盖住抽屉', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.locator('.topbar__burger').click()
    await expect(page.locator('.sidebar--drawer-open')).toBeVisible()

    // 由抽屉切换主内容区
    await page.locator('.sidebar--drawer-open a', { hasText: '浏览' }).click()
    await expect(page).toHaveURL(/\/browse/)

    // 若 View Transition 生效，转场快照（top layer）会盖住抽屉——此处应为抽屉本身
    const topClass = await page.evaluate(() => {
      const el = document.elementFromPoint(140, 400)
      return el ? el.className || el.tagName : null
    })
    expect(String(topClass)).toContain('sidebar--drawer-open')
  })
})

test.describe('登录弹窗', () => {
  test('提示文案为云同步说明，不含 VIP 字样', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '登录' }).click()
    const hint = page.locator('.login-modal__hint')
    await expect(hint).toContainText('登录后可享用免费云同步服务')
    await expect(hint).not.toContainText('VIP')
  })
})

test.describe('后端 API 契约', () => {
  test('健康检查返回 ok', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('ok')
  })

  test('搜索接口返回规范化曲目', async ({ request }) => {
    const res = await request.get('/api/search', {
      params: { keywords: FREE_SONG_KEYWORD, limit: 5 },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
    const t = body.data[0]
    expect(t).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      artist: expect.any(String),
    })
    // 封面应为 https
    expect(t.cover.startsWith('https://')).toBe(true)
  })

  test('音频流代理支持 Range 分段', async ({ request }) => {
    // 先搜到一个可播放曲目
    const s = await request.get('/api/search', {
      params: { keywords: FREE_SONG_KEYWORD, limit: 5 },
    })
    const songs = (await s.json()).data
    const id = songs.find((x: { id: string }) => x.id)?.id
    expect(id).toBeTruthy()

    const res = await request.get(`/stream/netease/${id}`, {
      headers: { Range: 'bytes=0-1023' },
    })
    // 206 或 200 均可接受（取决于源），但必须带音频类型且有字节
    expect([200, 206]).toContain(res.status())
    const buf = await res.body()
    expect(buf.byteLength).toBeGreaterThan(0)
    expect(res.headers()['content-type']).toContain('audio')
  })

  test('多类型搜索接口返回四类结果', async ({ request }) => {
    const res = await request.get('/api/search/all', {
      params: { keywords: FREE_SONG_KEYWORD, limit: 3 },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.songs)).toBe(true)
    expect(Array.isArray(body.data.artists)).toBe(true)
    expect(Array.isArray(body.data.albums)).toBe(true)
    expect(Array.isArray(body.data.playlists)).toBe(true)
    // 曲目应带艺人引用与专辑 id（供界面跳转）
    const song = body.data.songs[0]
    expect(Array.isArray(song.artistRefs)).toBe(true)
    expect(typeof song.artistRefs[0]?.id).toBe('string')
  })

  test('艺人 / 专辑详情接口返回契约', async ({ request }) => {
    const s = await request.get('/api/search/all', {
      params: { keywords: FREE_SONG_KEYWORD, limit: 3 },
    })
    const data = (await s.json()).data

    const artistId = data.artists?.[0]?.id
    if (artistId) {
      const ar = await request.get(`/api/artist/netease/${artistId}`)
      expect(ar.ok()).toBe(true)
      const b = await ar.json()
      expect(b.data.artist.id).toBe(String(artistId))
      expect(Array.isArray(b.data.tracks)).toBe(true)
      expect(Array.isArray(b.data.albums)).toBe(true)
    }

    const albumId = data.albums?.[0]?.id
    if (albumId) {
      const al = await request.get(`/api/album/netease/${albumId}`)
      expect(al.ok()).toBe(true)
      const b = await al.json()
      expect(b.data.album.id).toBe(String(albumId))
      expect(Array.isArray(b.data.tracks)).toBe(true)
    }
  })
})

test.describe('媒体缓存（Service Worker + IndexedDB）', () => {
  test('播放后音频被缓存进 IndexedDB', async ({ page }) => {
    await page.goto('/')
    // 等 SW 就绪并 reload，确保页面自首次音频请求起即受 SW 控制
    await page.evaluate(() => navigator.serviceWorker?.ready)
    await page.reload()

    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    // 缓存发生在整文件下载完成时，故轮询 audioMeta 表直至出现记录
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ db }) =>
              new Promise<number>((resolve) => {
                const req = indexedDB.open(db)
                req.onupgradeneeded = () => resolve(0)
                req.onsuccess = () => {
                  const d = req.result
                  if (!d.objectStoreNames.contains('mediaMeta')) {
                    d.close()
                    resolve(0)
                    return
                  }
                  const c = d
                    .transaction('mediaMeta', 'readonly')
                    .objectStore('mediaMeta')
                    .count()
                  c.onsuccess = () => {
                    d.close()
                    resolve(c.result)
                  }
                  c.onerror = () => {
                    d.close()
                    resolve(0)
                  }
                }
                req.onerror = () => resolve(0)
              }),
            { db: IDB_DB },
          ),
        { timeout: 30000, intervals: [1000] },
      )
      .toBeGreaterThan(0)
  })

  test('未命中缓存时 seek 型 Range 请求透传上游（206 而非 200 全量）', async ({
    page,
    request,
  }) => {
    await page.goto('/')
    // 等 SW 就绪并 reload，确保 fetch 自始即受 SW 控制
    await page.evaluate(() => navigator.serviceWorker?.ready)
    await page.reload()

    const s = await request.get('/api/search', {
      params: { keywords: FREE_SONG_KEYWORD, limit: 1 },
    })
    const id = (await s.json()).data[0].id

    // 用独立档位取一个不受其它用例影响的缓存 key；带 Range 的请求不得被 SW 接管，
    // 须由浏览器直发后端/CDN 并收到 206——否则 200 全量应答会让媒体内核中止/重启加载
    // （拖动进度条无法跳转、启停循环）
    const res = await page.evaluate(
      async ({ id }) => {
        const r = await fetch(`/stream/netease/${id}?level=standard`, {
          headers: { Range: 'bytes=1000-1099' },
        })
        const buf = await r.arrayBuffer()
        return {
          status: r.status,
          contentRange: r.headers.get('content-range'),
          bytes: buf.byteLength,
        }
      },
      { id },
    )

    expect(res.status).toBe(206)
    expect(res.contentRange).toMatch(/^bytes 1000-1099\//)
    expect(res.bytes).toBe(100)
  })

  test('拖动进度条 seek：带 Range 的请求直连线上、位置到位且无错误提示', async ({
    page,
    context,
  }) => {
    // 记录线上 /stream 请求：seek 型 Range 才会带有 Range 头（SW 不再接管）。
    // 旧实现会把 seek 吞成「无 Range 的整文件请求」，本用例据此变红。
    const seekRanges: string[] = []
    await context.route('**/stream/**', async (route) => {
      const range = route.request().headers()['range']
      if (range && !/^bytes=0-$/.test(range)) seekRanges.push(range)
      await route.continue()
    })

    await page.goto('/')
    await page.evaluate(() => navigator.serviceWorker?.ready)
    await page.reload()

    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    // 等进度条可用（元数据就绪）
    const slider = page.locator('[role="slider"][aria-label="播放进度"]')
    await expect(slider).not.toHaveAttribute('aria-disabled', 'true', {
      timeout: 15000,
    })

    // 点击进度条 80% 处：跳向未缓冲区间
    const box = await slider.boundingBox()
    if (!box) throw new Error('进度条不可见')
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2)

    // seek 必须以带 Range 的直连请求发出
    await expect
      .poll(() => seekRanges.length, { timeout: 15000 })
      .toBeGreaterThan(0)
    expect(seekRanges[0]).toMatch(/^bytes=\d+/)

    // 位置到位（跳转实际完成）
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const audio = document.querySelector('audio')
            if (!audio || !audio.duration) return 0
            return audio.currentTime / audio.duration
          }),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0.7)

    // 全程无错误提示
    await expect(page.locator('.toast[role="alert"]')).toHaveCount(0)
  })

  test('封面图片经 SW 缓存进 IndexedDB（与音频共用存储）', async ({ page }) => {
    await page.goto('/')
    // 等 SW 就绪并 reload，确保图片请求自始即受 SW 控制
    await page.evaluate(() => navigator.serviceWorker?.ready)
    await page.reload()

    // 搜索结果行带封面，触发对网易云 CDN 的图片请求
    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })

    // SW 以 CORS 拉取图片字节后写入 mediaMeta，轮询直至出现 image 条目
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ db }) =>
              new Promise<number>((resolve) => {
                const req = indexedDB.open(db)
                req.onsuccess = () => {
                  const d = req.result
                  if (!d.objectStoreNames.contains('mediaMeta')) {
                    d.close()
                    resolve(0)
                    return
                  }
                  const g = d
                    .transaction('mediaMeta', 'readonly')
                    .objectStore('mediaMeta')
                    .getAll()
                  g.onsuccess = () => {
                    d.close()
                    const rows = g.result as { kind?: string }[]
                    resolve(rows.filter((r) => r.kind === 'image').length)
                  }
                  g.onerror = () => {
                    d.close()
                    resolve(0)
                  }
                }
                req.onerror = () => resolve(0)
              }),
            { db: IDB_DB },
          ),
        { timeout: 30000, intervals: [1000] },
      )
      .toBeGreaterThan(0)
  })
})

test.describe('弱网韧性', () => {
  test('音频流挂起：播放键显示缓冲动画，超时后提示并回到暂停', async ({
    page,
    context,
  }) => {
    test.slow()
    // 拦截音频流并保持挂起（模拟弱网：请求发出但迟迟无响应）
    await context.route('**/stream/**', () => new Promise(() => {}))

    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    const title = (
      (await page
        .locator('.track-row .col-title__name')
        .first()
        .textContent()) ?? ''
    ).trim()
    await page.locator('.track-row').first().click()

    // 缓冲态可视化：播放键显示加载动画
    await expect(page.getByTestId('play-buffering')).toBeVisible({
      timeout: 8000,
    })

    // 起播超时兜底：出现提示，且最终回到暂停态（不无限等待）
    await expect(page.locator('.toast')).toBeVisible({ timeout: 20000 })
    await expect
      .poll(async () => (await audioState(page)).paused, { timeout: 10000 })
      .toBe(true)

    // 未误切歌：仍停留在原曲目
    await expect(page.locator('.playerbar__title')).toContainText(title)
  })

  test('音频流请求失败：提示错误并回暂停，解除故障后可重试播放', async ({
    page,
    context,
  }) => {
    await context.route('**/stream/**', (route) => route.abort('failed'))

    await page.goto('/search?q=' + encodeURIComponent(FREE_SONG_KEYWORD))
    await expect(page.locator('.track-row').first()).toBeVisible({
      timeout: 15000,
    })
    await page.locator('.track-row').first().click()

    // 请求失败：给出提示且回到暂停态（不静默停在「播放中」）
    await expect(page.locator('.toast')).toBeVisible({ timeout: 15000 })
    await expect
      .poll(async () => (await audioState(page)).paused, { timeout: 10000 })
      .toBe(true)

    // 等提示条自动消失（避免遮挡播放键）
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10000 })

    // 解除故障后重试：应能恢复播放（失败不导致播放器卡死）
    await context.unroute('**/stream/**')
    await page.getByTestId('play-toggle').click()
    await expect
      .poll(
        async () => {
          const s = await audioState(page)
          return s.exists && !s.paused && s.readyState >= 2
        },
        { timeout: 25000 },
      )
      .toBe(true)
  })
})
