import { defineConfig } from 'vite-plus'

// workspace 级格式 / 静态检查基准，`vp check` 会从各子包向上读取它。
// 格式口径与既有 .prettierrc.json 对齐（单引号、无分号、printWidth 80）。
export default defineConfig({
  fmt: { semi: false, singleQuote: true, printWidth: 80 },
  lint: {
    // 必须显式排除，否则 vp lint 会扫描 node_modules
    ignorePatterns: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.data/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/blob-report/**',
    ],
    options: { typeAware: true, typeCheck: true },
  },
})
