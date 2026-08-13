import type { UserConfig } from 'tsdown'
import { PLATFORM_MODULES } from './web-platform.ts'

/**
 * The only non-platform runtime contribution a client bundle may inline: the
 * generated self-import `dsh-subagent-admission/remote` produced once Task 8
 * generates the Typert Remote. Everything else under `@deepseek-ai/*` must be
 * a frozen platform module, or the build fails closed.
 */
const SELF_REMOTE = 'dsh-subagent-admission/remote'

/**
 * Standalone closure-factory client bundle preset: emits CJS to `lib/client.js`,
 * keeps the frozen platform modules external, and wraps the output with the
 * real loader handoff (`window.__ModuleLoader__.load({id, factory})`).
 */
export function dshClientBundle(id: string, entry: string): UserConfig {
  const externals = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client'] as const
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...externals],
    noExternal: (specifier: string) =>
      PLATFORM_MODULES.includes(specifier as never)
      || specifier === '@deepseek-ai/dsh-client-runtime/client'
        ? undefined
        : true,
    plugins: [{
      name: 'dsh-subagent-admission-client-purity',
      resolveId(source: string) {
        if (source === SELF_REMOTE) return null
        if (!source.startsWith('@deepseek-ai/')) return null
        if (externals.includes(source as never)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a frozen platform module or the generated `
          + `self import ${JSON.stringify(SELF_REMOTE)} — cross-plugin runtime imports are forbidden`,
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }
}
