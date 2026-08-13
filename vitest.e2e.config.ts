import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.e2e.ts'],
    passWithNoTests: true,
  },
})
