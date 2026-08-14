import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'

import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { defineConfig } from 'tsdown'
import { dshClientBundle } from '../../build/client-bundle.ts'

const baselineUrl = new URL('../../compatibility/baseline.json', import.meta.url)
const packageOutput = fileURLToPath(new URL('./lib', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

function embeddedBaseline(): string {
  const parsed = JSON.parse(readFileSync(baselineUrl, 'utf8')) as {
    readonly schemaVersion?: unknown
    readonly strictTargets?: unknown
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.strictTargets)) {
    throw new Error('dsh-subagent-admission: compatibility baseline is malformed')
  }
  return JSON.stringify({
    schemaVersion: 1,
    strictTargets: parsed.strictTargets,
  })
}

function externalPackageTypertPlugin() {
  const plugin = typertPlugin({ mode: 'package', faces: ['host'] })
  return {
    ...plugin,
    writeBundle(): void {
      // rc.6's package plugin searches upward for `tsconfig.host.json`; an
      // external package has one itself, so discovery stops below the actual
      // workspace and packageRoot() returns nothing. Keep the official
      // analyzer/emitter and only supply the already-known workspace/package.
      for (const filename of [
        'typert.host.js',
        'typert.host.d.ts',
        'typert.remote-client.js',
        'typert.remote-client.d.ts',
        'typert.remote-client.d.ts.map',
      ]) {
        rmSync(`${packageOutput}/${filename}`, { force: true })
      }
      const artifacts = new WorkspaceTypertGenerator(workspaceRoot)
        .generate(['dsh-subagent-admission'], ['host'])
      const matching = artifacts.filter(
        (artifact) => artifact.package === 'dsh-subagent-admission',
      )
      if (
        matching.length !== 1 ||
        matching[0]?.face !== 'host' ||
        matching[0].remote === undefined
      ) {
        throw new Error(
          'dsh-subagent-admission: Typert Host/Remote generation was incomplete',
        )
      }
      const [artifact] = matching
      mkdirSync(packageOutput, { recursive: true })
      writeFileSync(`${packageOutput}/typert.host.js`, artifact.js)
      writeFileSync(`${packageOutput}/typert.host.d.ts`, artifact.dts)
      writeFileSync(
        `${packageOutput}/typert.remote-client.js`,
        artifact.remote.js,
      )
      writeFileSync(
        `${packageOutput}/typert.remote-client.d.ts`,
        artifact.remote.dts,
      )
      writeFileSync(
        `${packageOutput}/typert.remote-client.d.ts.map`,
        artifact.remote.dtsMap,
      )
    },
  }
}

export default defineConfig(({ env }) => {
  const face = env?.DSH_BUILD_FACE
  if (face !== undefined && face !== 'host' && face !== 'client') {
    throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(face)}`)
  }
  const lib = {
    name: 'dsh-subagent-admission',
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    define: {
      __DSH_SUBAGENT_ADMISSION_BASELINE__: embeddedBaseline(),
    },
    plugins: externalPackageTypertPlugin(),
  }
  const client = dshClientBundle('dsh-subagent-admission', 'lib/types/client/index.js')
  if (face === 'host') return [lib]
  if (face === 'client') return [client]
  return [lib, client]
})
