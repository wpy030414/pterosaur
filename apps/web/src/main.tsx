import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRouter } from './components/AppRouter.js'
import App from './App.js'
import { useLibrary } from './store/library.js'
import { usePlayerQueue } from './store/playerQueue.js'
import { useOfflinePrefs } from './store/offlinePrefs.js'
import './styles/global.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 挂载点')

/**
 * 注册 Service Worker（**仅生产**）。
 *
 * SW 只做两件事（ADR-060）：应用外壳 7 天缓存、以及响应 `PREFETCH_AUDIO` 把整曲写进
 * 离线保存。它**不拦截任何请求**，故对路由、`/stream` 与 HMR 零影响；开发期完全不需要它
 * ——离线保存的写入走主线程 IDB，不依赖 SW。
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .catch((err: unknown) => {
      console.warn('[sw] 注册失败（不影响播放，仅离线外壳不可用）', err)
    })
}

/**
 * 引导应用。
 *
 * library 与播放队列的持久化都在异步的 IndexedDB：hydration 不再同步完成，
 * 在首帧前手动 `rehydrate()`，使收藏 / 最近 / 队列首次渲染即带数据，避免空态闪烁。
 * 两者互不依赖，并行恢复；任一失败都降级为空数据继续渲染。
 */
async function bootstrap(): Promise<void> {
  const rehydrate = async (
    run: () => Promise<void> | void,
    label: string,
    fallback: string,
  ) => {
    try {
      await run()
    } catch (err) {
      console.warn(`[${label}] 从 IndexedDB 恢复失败，将以${fallback}启动`, err)
    }
  }
  await Promise.all([
    rehydrate(() => useLibrary.persist.rehydrate(), 'library', '空库'),
    rehydrate(
      () => usePlayerQueue.persist.rehydrate(),
      'playerQueue',
      '空队列',
    ),
    rehydrate(
      () => useOfflinePrefs.persist.rehydrate(),
      'offlinePrefs',
      '默认偏好',
    ),
  ])

  createRoot(rootEl as HTMLElement).render(
    <StrictMode>
      <AppRouter>
        <App />
      </AppRouter>
    </StrictMode>,
  )

  registerServiceWorker()
}

void bootstrap()
