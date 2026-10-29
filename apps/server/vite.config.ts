import { defineConfig } from 'vite-plus'

// vp pack 对应 tsdown。把原 tsup.config.ts 的语义完整迁移：
// - entry src/index.ts、ESM、clean、outDir=dist
// - outExtensions 固定 .js（否则 tsdown 的 ESM 产物默认是 .mjs）
// - alwaysBundle @pterosaur/shared → 产物自包含，部署只需 node dist/index.js
//   注意：alwaysBundle 用 picomatch 匹配 **完整导入 id**，因此必须同时写包名与子路径 glob，
//   仅写 '@pterosaur/shared' 不会命中 '@pterosaur/shared/types' 等子路径导出。
// - neverBundle 保留三项外部依赖：
//   NeteaseCloudMusicApi（CJS 大包）、@hono/node-server（原生绑定）、
//   @ffmpeg-installer/ffmpeg（内部按平台探测二进制路径并 require JSON，打包必坏）
// - tsdown 默认保留 node: 前缀，等价于 tsup 的 removeNodeProtocol: false，
//   故 node:sqlite 等内建能正常解析。
export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist',
    clean: true,
    dts: false,
    platform: 'node',
    outExtensions: () => ({ js: '.js' }),
    deps: {
      alwaysBundle: ['@pterosaur/shared', '@pterosaur/shared/**'],
      neverBundle: [
        'NeteaseCloudMusicApi',
        '@hono/node-server',
        '@ffmpeg-installer/ffmpeg',
      ],
    },
  },
})
