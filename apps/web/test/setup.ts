import '@testing-library/jest-dom/vitest'
import {
  IDBKeyRange as FDBKeyRange,
  indexedDB as fakeIndexedDB,
} from 'fake-indexeddb'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom 未实现 IndexedDB：注入 fake-indexeddb，供 library 持久化与音频缓存单测覆盖真实路径。
// 必须在任何间接打开 IndexedDB 的模块被求值前完成（setup 先于测试文件执行）。
Object.defineProperty(globalThis, 'indexedDB', {
  value: fakeIndexedDB,
  configurable: true,
})
Object.defineProperty(globalThis, 'IDBKeyRange', {
  value: FDBKeyRange,
  configurable: true,
})

// 每个测试后卸载 React 树，避免相互污染
afterEach(() => {
  cleanup()
})

// jsdom 未实现 matchMedia，主题钩子依赖它
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

// jsdom 未实现 URL.createObjectURL（部分组件可能用到）
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:mock')
}

// 静默 localStorage 未实现时的报错
if (!window.localStorage) {
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    },
    writable: true,
  })
}
