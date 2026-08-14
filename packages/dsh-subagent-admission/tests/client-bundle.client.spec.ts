import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { dshClientBundle } from '../../../build/client-bundle'
import { PLATFORM_MODULES } from '../../../build/web-platform'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(packageRoot, 'lib', 'client.js')
const controllerTypesPath = resolve(packageRoot, 'lib', 'types', 'client', 'controller.d.ts')
const clientTypesDirectory = resolve(packageRoot, 'lib', 'types', 'client')

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

  it('inlines the generated Remote closure without local-path or undeclared-module leaks', () => {
    const source = readFileSync(bundlePath, 'utf8')
    expect(source).toContain('dsh-subagent-admission#snapshot/get')
    expect(source).toContain('dsh-subagent-admission#snapshot/watch')
    expect(source).not.toContain(packageRoot)
    expect(source).not.toContain(homedir())
    expect(source).not.toContain(basename(homedir()))

    let registration: {
      readonly id: string
      readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
    } | undefined
    runInNewContext(source, {
      AbortController,
      clearTimeout,
      console,
      setTimeout,
      window: {
        __ModuleLoader__: {
          load(value: typeof registration): void { registration = value },
        },
      },
    })
    expect(registration?.id).toBe('dsh-subagent-admission')

    const required: string[] = []
    const exports = registration!.factory((specifier) => {
      required.push(specifier)
      return {}
    })
    const allowed = new Set([
      ...PLATFORM_MODULES,
      '@deepseek-ai/dsh-client-runtime/client',
    ])
    expect(required.every(specifier => allowed.has(specifier as never))).toBe(true)
    expect(required).not.toContain('zod')
    expect(exports).toMatchObject({
      name: 'dsh-subagent-admission',
      inject: ['remote', 'slots', 'locale', 'sessions'],
      apply: expect.any(Function),
      AdmissionSnapshotController: expect.any(Function),
    })
  })

  it('publishes a declaration closure with JavaScript relative specifiers', () => {
    const source = readFileSync(controllerTypesPath, 'utf8')
    expect(source).toContain("from '../types.js'")
    expect(source).not.toMatch(/from ['"][^'"]+\.ts['"]/)
  })

  it('keeps every native-view declaration portable and free of local paths', () => {
    const declarations = readdirSync(clientTypesDirectory)
      .filter(file => file.endsWith('.d.ts'))
      .map(file => readFileSync(resolve(clientTypesDirectory, file), 'utf8'))
    expect(declarations).not.toHaveLength(0)
    for (const source of declarations) {
      expect(source).not.toMatch(/from ['"][^'"]+\.ts['"]/)
      expect(source).not.toContain(packageRoot)
      expect(source).not.toContain(homedir())
      expect(source).not.toContain(basename(homedir()))
    }
  })
})
