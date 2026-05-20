import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@douglas-agent/sandbank-core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@douglas-agent/sandbank-daytona': path.resolve(__dirname, 'packages/daytona/src/index.ts'),
      '@douglas-agent/sandbank-flyio': path.resolve(__dirname, 'packages/flyio/src/index.ts'),
    },
  },
  test: {
    include: ['test/conformance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
