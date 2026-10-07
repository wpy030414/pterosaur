import { test, expect, type Page } from '@playwright/test'

/**
 * E2E：顶栏设置弹窗 —— 缓存管理（查看 / 清理）与检查更新。
 *
 * 直接向 IndexedDB 的 `media` / `mediaMeta` 种入记录，避免依赖真实网络下载音频，
 * 从而稳定地验证「查看占用 → 清理 → 归零，且资料库保留」。
 */

const IDB_DB = 'pterosaur'
const LIBRARY_KEY = 'pterosaur-library'

interface SeedEntry {
  key: string
  kind: 'audio' | 'image'
  size: number
  mime: string
}

/** 向 media / mediaMeta 种入一条记录。 */
async function seedMedia(page: Page, entry: SeedEntry): Promise<void> {
  await page.evaluate(
    ({ db, entry }) =>
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
          const tx = d.transaction(['media', 'mediaMeta'], 'readwrite')
          tx.objectStore('media').put(
            new Blob([new Uint8Array(entry.size)], { type: entry.mime }),
            entry.key,
          )
          tx.objectStore('mediaMeta').put({ ...entry, lastAccess: Date.now() })
          tx.oncomplete = () => {
            d.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    { db: IDB_DB, entry },
  )
}

/** 种入一条 library 记录（验证清理缓存不会波及资料库）。 */
async function seedLibrary(page: Page): Promise<void> {
  await page.evaluate(
    ({ db, key }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(db)
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction('library', 'readwrite')
          tx.objectStore('library').put(
            { state: { favorites: [{ id: '1' }] }, version: 0 },
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

/** 读取 media / mediaMeta / library 的条目数。 */
async function storeCounts(
  page: Page,
): Promise<{ media: number; meta: number; favorites: number }> {
  return page.evaluate(
    (db) =>
      new Promise((resolve) => {
        const req = indexedDB.open(db)
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction(
            ['media', 'mediaMeta', 'library'],
            'readonly',
          )
          const a = tx.objectStore('media').count()
          const b = tx.objectStore('mediaMeta').count()
          const g = tx.objectStore('library').get('pterosaur-library')
          let favorites = 0
          g.onsuccess = () => {
            const v = g.result as
              { state?: { favorites?: unknown[] } } | undefined
            favorites = v?.state?.favorites?.length ?? 0
          }
          tx.oncomplete = () => {
            d.close()
            resolve({ media: a.result, meta: b.result, favorites })
          }
          tx.onerror = () => {
            d.close()
            resolve({ media: -1, meta: -1, favorites: -1 })
          }
        }
        req.onerror = () => resolve({ media: -1, meta: -1, favorites: -1 })
      }),
    IDB_DB,
  )
}

/**
 * 读取 media store 的全部 key。
 *
 * 断言「某条缓存被清除」时用它而非总量：应用会**在后台把封面写入同一个池**，
 * 若以总量为准则会与后台缓存竞态。种子条目的 key 是假地址，应用永不重取，故按 key 判定确定可靠。
 */
async function mediaKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    (db) =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open(db)
        req.onsuccess = () => {
          const d = req.result
          const tx = d.transaction('media', 'readonly')
          const k = tx.objectStore('media').getAllKeys()
          k.onsuccess = () => {
            const keys = (k.result as IDBValidKey[]).map(String)
            d.close()
            resolve(keys)
          }
          tx.onerror = () => {
            d.close()
            resolve([])
          }
        }
        req.onerror = () => resolve([])
      }),
    IDB_DB,
  )
}

/** 读取 library 收藏数（不受媒体缓存竞态影响）。 */
async function favoriteCount(page: Page): Promise<number> {
  return (await storeCounts(page)).favorites
}

/** 1×1 红色 PNG，用作自定义背景的 fixture。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 读取根元素上被 JS 覆写的 `--accent`（空串表示未覆写、回落默认红）。 */
function accentVar(page: Page): Promise<string> {
  return page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--accent'),
  )
}

test.describe('设置弹窗', () => {
  test('顶栏齿轮打开设置；Esc 关闭', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-button').click()

    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('cache-total')).toBeVisible()
    await expect(page.getByTestId('check-update')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('查看占用并清理缓存，资料库保留', async ({ page }) => {
    await page.goto('/')
    await seedMedia(page, {
      key: 'image|https://example.com/a.jpg',
      kind: 'image',
      size: 2048,
      mime: 'image/jpeg',
    })
    await seedMedia(page, {
      key: 'netease:123|exhigh',
      kind: 'audio',
      size: 4096,
      mime: 'audio/mpeg',
    })
    await seedLibrary(page)

    await page.getByTestId('settings-button').click()
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()

    // 总量与分项
    await expect(page.getByTestId('cache-total')).not.toHaveText('0 B')
    await expect(page.getByTestId('cache-breakdown')).toContainText('歌曲')
    await expect(page.getByTestId('cache-breakdown')).toContainText('封面')

    // 清理（无需二次确认，点击即生效）
    await page.getByTestId('clear-cache').click()

    // 媒体缓存归零，资料库保留
    // 注：按 key 判定（而非总量），避免与应用后台写入封面缓存的竞态
    await expect
      .poll(() => mediaKeys(page), { timeout: 5000 })
      .not.toContain('netease:123|exhigh')
    await expect
      .poll(() => mediaKeys(page))
      .not.toContain('image|https://example.com/a.jpg')
    expect(await favoriteCount(page)).toBe(1)
  })

  test('音质档位可选并持久化', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-button').click()
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()

    // 默认档位为 exhigh（选中态）
    await expect(page.getByTestId('quality-exhigh')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.getByTestId('quality-lossless').click()
    await expect(page.getByTestId('quality-lossless')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(page.getByTestId('quality-exhigh')).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // 刷新后仍为无损（localStorage 持久化）
    await page.reload()
    await page.getByTestId('settings-button').click()
    await expect(page.getByTestId('quality-lossless')).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  test('上传自定义背景：生效、取色替换主题色、可持久化与清除', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByTestId('settings-button').click()
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()

    // 未设置背景时无背景层、强调色为默认红（未被 JS 覆写）
    await expect(page.locator('.app-bg')).toHaveCount(0)
    expect(await accentVar(page)).toBe('')

    await page.getByTestId('background-input').setInputFiles({
      name: 'bg.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    })

    // 背景层出现，且强调色被取色结果覆写
    await expect(page.locator('.app-bg')).toBeVisible()
    await expect.poll(() => accentVar(page)).not.toBe('')

    // 持久化：刷新后仍在（媒体本体在 IndexedDB、元数据在 localStorage）
    await page.reload()
    await expect(page.locator('.app-bg')).toBeVisible()
    expect(await accentVar(page)).not.toBe('')

    // 清除背景 → 背景层消失、强调色回落默认
    await page.getByTestId('settings-button').click()
    await page.getByTestId('clear-background').click()
    await expect(page.locator('.app-bg')).toHaveCount(0)
    await expect.poll(() => accentVar(page)).toBe('')
  })

  test('检查更新触发整页刷新', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-button').click()
    await page.getByTestId('check-update').click()
    const confirm = page.getByRole('dialog', { name: '检查更新？' })
    await expect(confirm).toBeVisible()

    await Promise.all([
      page.waitForEvent('load'),
      confirm.getByRole('button', { name: '刷新', exact: true }).click(),
    ])

    const navType = await page.evaluate(
      () => performance.getEntriesByType('navigation')[0]?.type ?? '',
    )
    expect(navType).toBe('reload')
  })

  test('重置清空本机全部内容并刷新', async ({ page }) => {
    await page.goto('/')
    await seedMedia(page, {
      key: 'image|https://example.com/a.jpg',
      kind: 'image',
      size: 2048,
      mime: 'image/jpeg',
    })
    await seedMedia(page, {
      key: 'netease:123|exhigh',
      kind: 'audio',
      size: 4096,
      mime: 'audio/mpeg',
    })
    await seedLibrary(page)
    await page.evaluate(() => localStorage.setItem('pterosaur-probe', '1'))

    await page.getByTestId('settings-button').click()
    await page.getByTestId('reset-all').click()

    const confirm = page.getByRole('dialog', { name: '重置？' })
    await expect(confirm).toBeVisible()
    await Promise.all([
      page.waitForEvent('load'),
      confirm.getByRole('button', { name: '重置', exact: true }).click(),
    ])

    // 整页刷新
    const navType = await page.evaluate(
      () => performance.getEntriesByType('navigation')[0]?.type ?? '',
    )
    expect(navType).toBe('reload')

    // 本机内容清空：localStorage 与 IndexedDB（媒体缓存 + 资料库）
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pterosaur-probe')))
      .toBeNull()
    // 按 key / 收藏数判定，避免与应用后台写入封面缓存的竞态
    await expect
      .poll(() => mediaKeys(page), { timeout: 5000 })
      .not.toContain('netease:123|exhigh')
    await expect
      .poll(() => mediaKeys(page))
      .not.toContain('image|https://example.com/a.jpg')
    expect(await favoriteCount(page)).toBe(0)
  })
})
