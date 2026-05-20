import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@douglas-agent/sandbank-core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@douglas-agent/sandbank-relay': resolve(__dirname, 'packages/relay/src/index.ts'),
      '@douglas-agent/sandbank-agent': resolve(__dirname, 'packages/agent/src/index.ts'),
      '@douglas-agent/sandbank-boxlite': resolve(__dirname, 'packages/boxlite/src/index.ts'),
      '@douglas-agent/sandbank-cloud': resolve(__dirname, 'packages/cloud/src/index.ts'),
    },
  },
  test: {
    testTimeout: 120_000,
    exclude: ['**/e2e/**', '**/conformance/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/test/**', '**/*.test.ts'],
    },
  },
})
