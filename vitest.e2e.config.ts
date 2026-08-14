import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { defineConfig } from 'vitest/config'

const typert = typertPlugin({ mode: 'package', faces: ['host'] })

export default defineConfig({
  plugins: [{
    name: 'dsh-typert-decorator-lowering',
    enforce: 'pre',
    transform: typert.transform,
  }],
  test: {
    environment: 'node',
    include: ['packages/**/*.e2e.ts'],
    passWithNoTests: true,
  },
})
