import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // 复用同一 worker 内的 jsdom 环境（保留每文件隔离），避免每文件重建环境带来的开销
    pool: 'vmThreads',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./apps/web/test/setup.ts'],
    include: [
      'apps/*/test/**/*.{test,spec}.{ts,tsx}',
      'packages/*/test/**/*.{test,spec}.ts',
    ],
    css: false,
    restoreMocks: true,
  },
})
