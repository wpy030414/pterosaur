import type { LibraryData, SyncEnvelope } from '@pterosaur/shared/types'
import { API_BASE } from '@pterosaur/shared/types'
import { api } from '../api/client.js'
import { useLibrary } from '../store/library.js'
import { useSync } from '../store/sync.js'

/**
 * library 云同步引擎（**云端权威**）。
 *
 * 语义：进入同步启用态（登录瞬间 / 打开开关瞬间 / 打开页面瞬间）时，以**云端覆盖本地**；
 * 唯一的边界是**云端为空**——此时反过来以本地为准并上传。此后本地每次变更都防抖推送到云端
 * （服务端指派新 `rev` 并广播给其它连接），其它设备经 SSE 收到 `rev` 后重拉。
 *
 * 版本号一律由服务端指派（见 `SyncEnvelope.rev`）；客户端不产生时间戳。
 *
 * 纯函数 {@link snapshotLibrary} / {@link emptyLibrary} 与 {@link applyPayload} 便于单测；
 * 其余函数读写 store / 发请求。
 */

/** 从 library store 抽出可同步的数据字段。 */
export function snapshotLibrary(): LibraryData {
  const s = useLibrary.getState()
  return {
    favorites: s.favorites,
    recent: s.recent,
    playlists: s.playlists,
    savedPlaylists: s.savedPlaylists,
    savedArtists: s.savedArtists,
    savedAlbums: s.savedAlbums,
  }
}

/** 空 library（云端为空时上传 / 重置时清空云端副本）。 */
export function emptyLibrary(): LibraryData {
  return {
    favorites: [],
    recent: [],
    playlists: [],
    savedPlaylists: [],
    savedArtists: [],
    savedAlbums: [],
  }
}

/**
 * 抑制位：把云端数据写入本地时置位，避免 library 订阅把它当成「本地修改」又推回云端（回声）。
 * 放在模块级（而非 store）以免被持久化。
 */
let applying = false

/** 把云端载荷写入本地 library（随 persist 落盘），期间抑制变更回推，并记下云端版本号。 */
export function applyPayload(state: Partial<LibraryData>, rev: number): void {
  applying = true
  try {
    // 以空库为底、用云端载荷覆盖：云端可能来自旧版本、缺后续新增字段，缺省处即回落空值。
    // 不逐字段枚举——新增字段随 `emptyLibrary()` 自动获得默认值，避免校验逻辑随字段增长而污染。
    useLibrary.setState({ ...emptyLibrary(), ...state })
    useSync.getState().touch(rev)
  } finally {
    applying = false
  }
}

/** 拉取云端载荷（未登录 / 无数据返回 null）。 */
export async function pullLibrary(): Promise<SyncEnvelope | null> {
  const { payload } = await api.syncGet()
  return payload
}

/** 把当前本地 library 推送到云端，并把本机版本号推进到服务端返回的 `rev`。 */
export async function pushLibrary(): Promise<void> {
  const saved = await api.syncPut(snapshotLibrary())
  useSync.getState().touch(saved.rev ?? 0)
}

/** 推送一份全新的空 library（重置时清空云端副本）。 */
export async function pushEmptyLibrary(): Promise<void> {
  const saved = await api.syncPut(emptyLibrary())
  useSync.getState().touch(saved.rev ?? 0)
}

/**
 * 进入同步启用态时的一次同步：**云端权威**——有云端数据即以云端覆盖本地；
 * 云端为空则以本地为准并上传（登录 / 开开关 / 打开页面，三处统一）。
 */
export async function syncOnEntry(): Promise<void> {
  const server = await pullLibrary()
  if (server) applyPayload(server.state, server.rev ?? 0)
  else await pushLibrary()
}

/**
 * 订阅本地 library 变更 → 防抖推送到云端；返回取消订阅函数。
 *
 * @param delayMs 防抖时长；同一窗口内的多次变更只推最后一次。
 */
export function startLibrarySync(delayMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = useLibrary.subscribe(() => {
    if (applying) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void pushLibrary().catch((e) =>
        console.warn('[sync] 推送 library 失败', e),
      )
    }, delayMs)
  })
  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}

/**
 * 云端 → 本地实时通道（SSE）。
 *
 * 收到 `{ rev }` 且比本机已知版本新时重拉并应用（云端权威）。连接断开后每 `retryMs`
 * 重试一次，**永不停止**；返回清理函数（失活 / 换账号时调用）。
 * 无 `EventSource` 的环境（jsdom 等）静默降级。
 */
export function startEventStream(retryMs = 5000): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  let es: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const open = () => {
    if (stopped) return
    es = new EventSource(`${API_BASE}/sync/events`)
    es.addEventListener('rev', (ev) => {
      let rev: number
      try {
        rev = (JSON.parse((ev as MessageEvent).data) as { rev: number }).rev
      } catch {
        return
      }
      if (typeof rev !== 'number' || rev <= useSync.getState().rev) return
      void pullLibrary()
        .then((server) => {
          if (server) applyPayload(server.state, server.rev ?? rev)
        })
        .catch((e) => console.warn('[sync] SSE 拉取失败', e))
    })
    es.onerror = () => {
      es?.close()
      es = null
      if (stopped) return
      // 断开后 5s 重连一次，永不停止
      if (timer) clearTimeout(timer)
      timer = setTimeout(open, retryMs)
    }
  }

  open()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    es?.close()
    es = null
  }
}
