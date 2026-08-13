import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dshClientBundle } from '../../../build/client-bundle'
import { PLATFORM_MODULES } from '../../../build/web-platform'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(packageRoot, 'lib', 'client.js')

describe('dsh-subagent-admission client bundle', () => {
  it('configures the standalone closure-factory handoff and external table', () => {
    const config = dshClientBundle('dsh-subagent-admission', 'lib/types/client/index.js')
    expect(config.name).toBe('dsh-subagent-admission/client')
    expect(config.format).toBe('cjs')
    expect(config.platform).toBe('browser')
    expect(config.external).toEqual([...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client'])
    expect(config.outputOptions?.entryFileNames).toBe('client.js')
    expect(config.outputOptions?.banner).toBe(
      'window.__ModuleLoader__.load({ id: "dsh-subagent-admission", factory: (require) => {',
    )
    expect(config.outputOptions?.intro).toBe('var module = { exports: {} }; var exports = module.exports;')
    expect(config.outputOptions?.footer).toBe('return module.exports; } });')
    expect(config.plugins).toHaveLength(1)
  })

  it('emits a built artifact that registers the plugin id with the loader', () => {
    const source = readFileSync(bundlePath, 'utf8')
    expect(source).toContain('window.__ModuleLoader__.load')
    expect(source).toMatch(/id:\s*"dsh-subagent-admission"/)
    expect(source).toMatch(/factory:\s*\(require\)\s*=>\s*\{/)
    expect(source).toContain('return module.exports;')
    expect(source.match(/window\.__ModuleLoader__\.load/g)).toHaveLength(1)
  })
})
