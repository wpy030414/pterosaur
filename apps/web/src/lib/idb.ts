/**
 * 低层 IndexedDB 封装：主线程与 Service Worker 共用。
 *
 * 设计约束：
 * - 只依赖纯 IDB API，**不引用 `window` / `self` / `document`**，以便 `sw.ts` 独立打包复用同一份源码。
 * - 惰性打开并缓存 open Promise，避免每次操作重开连接。
 * - 在一个连接上幂等创建所需的 object store（`library` / `media` / `mediaMeta`）。
 * - **优雅降级**：`indexedDB` 缺失或打开失败时，读返回空、写为 no-op，
 *   使上层 store 永不因存储层不可用而崩溃（如隐私模式、无 IDB 的测试环境）。
 *
 * 所有操作以 `transaction.oncomplete` 为准 resolve，保证「已持久化」语义清晰。
 */

/** IDB 库名。 */
export const DB_NAME = 'pterosaur'
/**
 * 库版本；新增 object store / 索引时递增。
 * v2 起用 `media` / `mediaMeta` 取代 v1 的 `audio` / `audioMeta`；
 * v3 因音频缓存键加入源前缀（`<source>:<id>|<level>`），旧键不再命中，升级时清空媒体缓存重建。
 * v4 新增 `background` store（自定义应用背景的媒体本体）。
 */
export const DB_VERSION = 4
/** 存 zustand persist 封套 `{state, version}` 的通用键值 store（out-of-line key）。 */
export const LIBRARY_STORE = 'library'
/** 存**全部媒体** blob 的 store（音频 + 封面；out-of-line key = 缓存 key，值为裸 `Blob`）。 */
export const MEDIA_STORE = 'media'
/**
 * 存媒体缓存的元数据（`keyPath: 'key'`，含 `kind: 'audio' | 'image'`）。
 * 与 blob 分离，使 LRU 淘汰只需遍历轻量元数据、无需把全部 blob 载入内存。
 */
export const MEDIA_META_STORE = 'mediaMeta'
/**
 * 存**自定义应用背景**的媒体本体（单条，out-of-line key 固定）。
 * 独立于媒体缓存池：背景是本地设置，**不参与 LRU 淘汰**，也**不被登录 / 退出的清缓存波及**
 * （见 `lib/clearCaches.ts`）。
 */
export const BACKGROUND_STORE = 'background'
/** v1 遗留的音频 store 名（v2 升级时删除；缓存可弃，`library` 不受影响）。 */
const LEGACY_AUDIO_STORE = 'audio'
const LEGACY_AUDIO_META_STORE = 'audioMeta'

let dbPromise: Promise<IDBDatabase | null> | null = null

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function openDB(): Promise<IDBDatabase | null> {
  if (!hasIndexedDB()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      console.warn('[idb] 无法打开 IndexedDB，持久化降级为内存', err)
      resolve(null)
      return
    }

    req.onupgradeneeded = (event) => {
      const db = req.result
      const oldVersion = event.oldVersion
      // v3：音频缓存键加入源前缀，旧键（无源）不再命中——清空媒体缓存重建（缓存可弃）。
      if (oldVersion > 0 && oldVersion < 3) {
        if (db.objectStoreNames.contains(MEDIA_STORE))
          db.deleteObjectStore(MEDIA_STORE)
        if (db.objectStoreNames.contains(MEDIA_META_STORE))
          db.deleteObjectStore(MEDIA_META_STORE)
      }
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        // out-of-line key：调用方以 persist 的 name 作为 key
        db.createObjectStore(LIBRARY_STORE)
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        // 裸 Blob 以缓存 key 为 out-of-line key 存储（音频与封面共用）
        db.createObjectStore(MEDIA_STORE)
      }
      if (!db.objectStoreNames.contains(MEDIA_META_STORE)) {
        const meta = db.createObjectStore(MEDIA_META_STORE, { keyPath: 'key' })
        // LRU 遍历/淘汰辅助索引
        meta.createIndex('lastAccess', 'lastAccess')
      }
      if (!db.objectStoreNames.contains(BACKGROUND_STORE)) {
        // 自定义应用背景的媒体本体（单条，out-of-line key 固定）
        db.createObjectStore(BACKGROUND_STORE)
      }
      // v1 的音频缓存 store 已被 media / mediaMeta 取代：缓存可弃，直接删除
      if (db.objectStoreNames.contains(LEGACY_AUDIO_STORE))
        db.deleteObjectStore(LEGACY_AUDIO_STORE)
      if (db.objectStoreNames.contains(LEGACY_AUDIO_META_STORE))
        db.deleteObjectStore(LEGACY_AUDIO_META_STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      // 他处请求更高版本时本连接必须让路：否则旧连接会把它永久阻塞（升级卡死）。
      // 让路后清空缓存连接，使后续 getDB() 重新以新版本打开。
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onblocked = () => {
      console.warn(
        '[idb] 升级被其它连接阻塞（可能有旧标签页或旧 Service Worker 持有连接）',
      )
      // 清空缓存连接，使后续 getDB() 能以新版本重试打开
      dbPromise = null
    }
    req.onerror = () => {
      console.warn('[idb] 打开 IndexedDB 失败，持久化降级为内存', req.error)
      resolve(null)
    }
  })
}

/** 获取（并缓存）数据库连接；不可用时返回 `null`。 */
export function getDB(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = openDB()
  return dbPromise
}

/**
 * 在一个事务内执行 `run`，以事务完成作为 resolve 边界。
 * 数据库不可用时直接以 `fallback` resolve（降级）。
 */
function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  return getDB().then((db) => {
    if (!db) return fallback
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction(storeName, mode)
      } catch (err) {
        // 连接失效（如被 onversionchange 关闭）时降级
        console.warn('[idb] 创建事务失败', err)
        resolve(fallback)
        return
      }
      let result: T = fallback
      const req = run(tx.objectStore(storeName))
      req.onsuccess = () => {
        result = (req.result as T) ?? fallback
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  })
}

/** 读取单个 key；不存在或降级时返回 `undefined`。 */
export function idbGet<T = unknown>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return withStore<T | undefined>(
    storeName,
    'readonly',
    (s) => s.get(key),
    undefined,
  )
}

/** 读取整个 store；降级时返回 `[]`。 */
export function idbGetAll<T = unknown>(storeName: string): Promise<T[]> {
  return withStore<T[]>(storeName, 'readonly', (s) => s.getAll(), [])
}

/**
 * 写入。`key` 省略时依赖 store 自身的 `keyPath`（如 `audio` 的 `key`）；
 * 提供 `key` 时按 out-of-line key 写入（如 `library`）。
 */
export function idbPut(
  storeName: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  return withStore<void>(
    storeName,
    'readwrite',
    (s) => (key === undefined ? s.put(value) : s.put(value, key)),
    undefined,
  )
}

/** 删除单个 key。 */
export function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  return withStore<void>(
    storeName,
    'readwrite',
    (s) => s.delete(key),
    undefined,
  )
}

/** 清空整个 store。 */
export function idbClear(storeName: string): Promise<void> {
  return withStore<void>(storeName, 'readwrite', (s) => s.clear(), undefined)
}

/** 批量写入（同一事务内），用于音频缓存的淘汰/写入组合。 */
export async function idbBatch(
  storeName: string,
  ops: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await getDB()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(storeName, 'readwrite')
    } catch (err) {
      console.warn('[idb] 创建事务失败', err)
      resolve()
      return
    }
    ops(tx.objectStore(storeName))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
