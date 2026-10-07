import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  outDir: 'dist',
  external: ['NeteaseCloudMusicApi', '@hono/node-server'],
  noExternal: ['@pterosaur/shared'],
  // tsup 默认会剥掉 `node:` 前缀（为兼容 Node < 14.18）。但部分内建**只能**以 `node:` 访问，
  // 如 `node:sqlite`（云同步存储）——剥成 `sqlite` 会被当作不存在的包、启动即崩。
  // 本项目 engine 为 Node ≥ 23.4，前缀必然受支持，故关闭该改写。
  removeNodeProtocol: false,
})
