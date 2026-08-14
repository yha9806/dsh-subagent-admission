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
    // Conformance/crash sources under tests/ are materialized by their
    // dedicated runners into package or pinned-checkout graphs. They are not
    // root-resolvable standalone suites.
    include: ['packages/**/*.e2e.ts', 'tests/packed-install.e2e.ts'],
    passWithNoTests: true,
  },
})
