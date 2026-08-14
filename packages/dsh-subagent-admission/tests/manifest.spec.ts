import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(workspaceRoot, relativePath), 'utf8'))
}

describe('dsh-subagent-admission package manifest', () => {
  it('declares one installable dual-face DSH bundle', () => {
    const manifest = readJson('packages/dsh-subagent-admission/package.json')
    expect(manifest.name).toBe('dsh-subagent-admission')
    expect(manifest.version).toBe('0.1.0-rc.1')
    expect(manifest.engines).toEqual({ node: '^22.19.0 || >=24.0.0' })
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
    })
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./types')
    expect(manifest.exports).toHaveProperty('./typert', {
      types: './lib/typert.host.d.ts',
      default: './lib/typert.host.js',
    })
    expect(manifest.exports).toHaveProperty('./remote', {
      types: './lib/typert.remote-client.d.ts',
      default: './lib/typert.remote-client.js',
    })
  })

  it('allowlists only the generated artifact faces', () => {
    const manifest = readJson('packages/dsh-subagent-admission/package.json')
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'lib/client.js',
      'lib/types/**/*.js',
      'lib/types/**/*.d.ts',
      'lib/typert.host.js',
      'lib/typert.host.d.ts',
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
      'cordis.patch.yml',
    ])
  })

  it('generates an exactly read-only Snapshot Remote surface', () => {
    const remoteJs = readFileSync(
      resolve(
        workspaceRoot,
        'packages/dsh-subagent-admission/lib/typert.remote-client.js',
      ),
      'utf8',
    )
    const remoteTypes = readFileSync(
      resolve(
        workspaceRoot,
        'packages/dsh-subagent-admission/lib/typert.remote-client.d.ts',
      ),
      'utf8',
    )
    const descriptorIds = [...remoteJs.matchAll(/\bid: '([^']+)'/g)]
      .map((match) => match[1])
    const methods = [...remoteJs.matchAll(/\bmethod: '([^']+)'/g)]
      .map((match) => match[1])

    expect(descriptorIds).toEqual([
      'dsh-subagent-admission#snapshot/get',
      'dsh-subagent-admission#snapshot/watch',
    ])
    expect(methods).toEqual(['get', 'watch'])
    expect(
      methods.filter((method) =>
        ['set', 'reset', 'release', 'kill', 'retry'].includes(method),
      ),
    ).toEqual([])
    expect(remoteTypes).toContain("'snapshot/get'")
    expect(remoteTypes).toContain("'snapshot/watch'")
  })

  it('carries exactly one bundle patch row with audit defaults', () => {
    const patch = readFileSync(
      resolve(workspaceRoot, 'packages/dsh-subagent-admission/cordis.patch.yml'),
      'utf8',
    )
    expect(patch.match(/- insert:/g)).toHaveLength(1)
    expect(patch.match(/- id: subagent-admission/g)).toHaveLength(1)
    expect(patch).toContain('name: dsh-subagent-admission')
    expect(patch).toContain('mode: audit')
    expect(patch).toContain('globalActive: 6')
    expect(patch).toContain('perRootActive: 4')
    expect(patch).toContain('perRootAdmittedTotal: 24')
    expect(patch).toContain('perParentChildren: 8')
    expect(patch).toContain("ownershipPath: !!js dshHomePath('sessions/.dsh-subagent-admission-owner')")
  })

  it('records source/npm divergence instead of inventing one current version', () => {
    const baseline = readJson('compatibility/baseline.json')
    expect(baseline.schemaVersion).toBe(1)
    expect(baseline.source.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.source.packageVersion).toBeTruthy()
    expect(baseline.npm['@deepseek-ai/dsh-subagent'].next).toBeTruthy()
    expect(baseline.discussion131.url).toBe('https://github.com/deepseek-ai/deepseek-harness/discussions/131')
    expect(baseline.discussion131.state).toMatch(/^(open|closed)$/)
    expect(baseline.discussion131.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(baseline.strictTargets).toEqual([{
      patchSha256: createHash('sha256')
        .update(readFileSync(resolve(workspaceRoot, 'patches/dsh-subagent-admission-seam.patch')))
        .digest('hex'),
      protocolVersion: 1,
      sourceCommit: baseline.source.commit,
      sourcePackageVersion: baseline.source.packageVersion,
      verificationCommand: 'corepack pnpm tsx scripts/verify-seam-patch.mts',
    }])
    expect(baseline.strictTargetsCurrent).toBe(true)
    expect(['aligned', 'source-npm-diverged']).toContain(baseline.status)
  })
})
