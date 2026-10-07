import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRouter } from './components/AppRouter.js'
import type { MusicSource } from '@pterosaur/shared/types'
import App from './App.js'
import { useLibrary } from './store/library.js'
import { usePlayer } from './store/player.js'
import './styles/global.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 挂载点')

/**
 * 注册音频缓存 Service Worker。
 * 该 SW 只拦截 `/stream/*`（音频代理），其余请求原样放行，故对路由与 HMR 无影响。
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return
  const isProd = import.meta.env.PROD
  const url = isProd ? '/sw.js' : '/src/sw.ts'
  // 生产：经典 SW（injectManifest 以 IIFE 产出），禁用 HTTP 缓存以免注册脚本本身陈旧；
  // 开发：SW 源码在 `/src/sw.ts`，默认作用域只有 `/src/`，需显式声明 `scope: '/'` 才能真正
  // 控制页面（相应的 `Service-Worker-Allowed: /` 由 vite.config.ts 的 dev 中间件补上）。
  const options: RegistrationOptions | undefined = isProd
    ? { updateViaCache: 'none' }
    : { type: 'module', scope: '/' }
  navigator.serviceWorker.register(url, options).catch((err: unknown) => {
    console.warn('[sw] 注册失败（不影响播放，仅离线缓存不可用）', err)
  })
}

/**
 * 订阅 SW 通知：后端对音频流返回 403（VIP / 版权受限）时提示并给出登录入口。
 * 音频元素的 error 事件无法区分「网络失败」与「版权受限」，故登录引导只据此后端信号。
 */
function listenServiceWorkerMessages(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; source?: MusicSource } | null
    if (data?.type === 'STREAM_NEED_LOGIN') {
      usePlayer
        .getState()
        .setPlayError('该曲目暂不可播放', true, data.source ?? null)
    }
  })
}

/**
 * 引导应用。
 *
 * library 持久化已迁移到异步的 IndexedDB，hydration 不再同步完成；在首帧前手动 `rehydrate()`，
 * 使收藏/最近等页面首次渲染即带数据，避免空态闪烁。IDB 不可用时降级为空库继续渲染。
 */
async function bootstrap(): Promise<void> {
  try {
    await useLibrary.persist.rehydrate()
  } catch (err) {
    console.warn('[library] 从 IndexedDB 恢复失败，将以空库启动', err)
  }

  createRoot(rootEl as HTMLElement).render(
    <StrictMode>
      <AppRouter>
        <App />
      </AppRouter>
    </StrictMode>,
  )

  registerServiceWorker()
  listenServiceWorkerMessages()
}

void bootstrap()
