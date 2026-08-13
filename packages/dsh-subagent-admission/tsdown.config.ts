import { defineConfig } from 'tsdown'
import { dshClientBundle } from '../../build/client-bundle.ts'

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
  }
  const client = dshClientBundle('dsh-subagent-admission', 'lib/types/client/index.js')
  if (face === 'host') return [lib]
  return [lib, client]
})
