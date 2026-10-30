import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

/**
 * E2E：翻录升级——分发方式选择、数字分发的 meta.json 与实体直刻（模拟刻录缝）。
 *
 * 服务端以 `PTEROSAUR_RIP_FAKE_BURN=1` 启动（见 playwright.config）：刻录机探测 / 取流 /
 * 刻录全链路模拟，用例完全离线；浏览器侧音频经 `context.route` 注入假字节。
 * SW 在本组用例中禁用（`serviceWorkers: 'block'`），保证拦截确定性生效。
 */

const IDB_DB = 'pterosaur'
const LIBRARY_KEY = 'pterosaur-library'

const e2eTrack = (id: string, title: string) => ({
  source: 'netease',
  id,
  title,
  artist: 'E2E 艺术家',
  album: 'E2E 专辑',
  cover: 'https://p3.music.126.net/e2e.jpg',
  duration: 180,
  fee: 'free',
})

/** 种入两条收藏曲目（library 持久化于 IndexedDB）。 */
async function seedFavorites(page: Page): Promise<void> {
  const t1 = e2eTrack('e2e-1', 'E2E 曲一')
  const t2 = e2eTrack('e2e-2', 'E2E 曲二')
  await page.evaluate(
    ({ db, key, value }) =>
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
          const tx = d.transaction('library', 'readwrite')
          tx.objectStore('library').put(value, key)
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
      key: LIBRARY_KEY,
      value: {
        state: {
          favorites: [t1, t2],
          recent: [],
          playlists: [],
          savedPlaylists: [],
          savedArtists: [],
          savedAlbums: [],
        },
        version: 0,
      },
    },
  )
}

/** 打开翻录对话框并做基础断言（默认数字分发选中）。 */
async function openRipDialog(page: Page) {
  await page.getByRole('button', { name: '翻录' }).click()
  const dialog = page.getByRole('dialog', { name: /翻录.*我喜欢的音乐/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('rip-dist-digital')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  return dialog
}

test.describe('翻录：分发方式与产物', () => {
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ context, page }) => {
    await context.route('**/stream/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        body: 'E2E-FAKE-AUDIO',
      }),
    )
    await context.route(/\.music\.126\.net\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
    )
    await page.goto('/')
    await seedFavorites(page)
    await page.goto('/favorites')
    await expect(page.getByText('E2E 曲一')).toBeVisible()
  })

  test('数字分发：ZIP 下载含音频与 meta.json', async ({ page }) => {
    const dialog = await openRipDialog(page)
    // 非本机不拉取能力；本机（127.0.0.1）会拉——都无碍数字分发
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: '开始翻录' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('我喜欢的音乐.zip')

    const buf = await readFile((await download.path())!)
    expect(buf.includes(Buffer.from('meta.json'))).toBe(true)
    expect(buf.includes(Buffer.from('pterosaur-rip@1'))).toBe(true)
    expect(buf.includes(Buffer.from('E2E 曲一'))).toBe(true)
    expect(buf.includes(Buffer.from('E2E 曲二'))).toBe(true)

    // 进度环出现后自行消退
    await expect(page.getByTestId('rip-progress')).toHaveCount(0)
  })

  test('实体分发（数据 CD）：模拟刻录完成并下载 meta.json', async ({
    page,
  }) => {
    // 防御 reuseExistingServer 命中非模拟服务：能力必须报 simulated
    const caps = await (await page.request.get('/api/rip/capabilities')).json()
    expect(caps.data.simulated).toBe(true)

    const dialog = await openRipDialog(page)
    await dialog.getByTestId('rip-dist-physical').click()
    await expect(dialog.getByTestId('rip-caps')).toHaveText(/刻录机 1 台/)
    await expect(dialog.getByTestId('rip-disc-data')).toHaveAttribute(
      'aria-checked',
      'true',
    )

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: '开始刻录' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('meta.json')
    const meta = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(meta.schema).toBe('pterosaur-rip@1')
    expect(meta.distribution).toBe('physical')
    expect(meta.discType).toBe('data')
    expect(meta.kind).toBe('favorites')
    expect(meta.trackCount).toBe(2)
    // 模拟取流产物为合成 WAV，数据 CD 上盘应有对应文件名回填
    expect(meta.tracks[0].file).toMatch(/^1 - .*\.wav$/)

    await expect(page.getByTestId('rip-progress')).toHaveCount(0)
  })

  test('实体分发（音频 CD）：进度进入刻录阶段，meta 无逐曲文件', async ({
    page,
  }) => {
    const dialog = await openRipDialog(page)
    await dialog.getByTestId('rip-dist-physical').click()
    await expect(dialog.getByTestId('rip-caps')).toHaveText(/刻录机 1 台/)
    await dialog.getByTestId('rip-disc-audio').click()
    await expect(dialog.getByTestId('rip-disc-audio')).toHaveAttribute(
      'aria-checked',
      'true',
    )

    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '开始刻录' }).click()

    // 刻录阶段（不确定进度）：模拟刻录刻意为该阶段留出可观测窗口
    await expect(page.getByTestId('rip-progress')).toHaveAttribute(
      'data-phase',
      'burn',
      { timeout: 20_000 },
    )

    const download = await downloadPromise
    const meta = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(meta.discType).toBe('audio')
    expect(meta.tracks[0].file).toBeUndefined()
    expect(meta.cover).toBeUndefined()
  })
})
