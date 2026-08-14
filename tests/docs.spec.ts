import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function pathOf(relativePath: string): string {
  return resolve(ROOT, relativePath)
}

function text(relativePath: string): string {
  return readFileSync(pathOf(relativePath), 'utf8')
}

function json(relativePath: string): Record<string, any> {
  return JSON.parse(text(relativePath)) as Record<string, any>
}

function sha256(relativePath: string): string {
  return createHash('sha256').update(readFileSync(pathOf(relativePath))).digest('hex')
}

function pngDimensions(relativePath: string): { width: number; height: number } {
  const value = readFileSync(pathOf(relativePath))
  expect(value.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(value.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) }
}

describe('release-candidate documentation', () => {
  it('ships every bounded release document', () => {
    for (const relativePath of [
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'SECURITY.md',
      'THIRD_PARTY_NOTICES.md',
      'CHANGELOG.md',
      'docs/architecture.md',
      'docs/compatibility.md',
      'docs/upstream-seam.md',
      'docs/reproduction.md',
      'compatibility/ecosystem-audit.md',
      'docs/assets/admission-control.png',
      'evidence/.gitkeep',
    ]) {
      expect(existsSync(pathOf(relativePath)), relativePath).toBe(true)
      if (!relativePath.endsWith('.gitkeep')) {
        expect(statSync(pathOf(relativePath)).size, relativePath).toBeGreaterThan(0)
      }
    }
  })

  it('states the Reframe v2 claim and evidence boundaries in both languages', () => {
    const english = text('README.md')
    const chinese = text('README.zh-CN.md')
    for (const phrase of [
      'shared lifecycle admission protocol',
      'reference policy kernel',
      'Discussion #131',
      '**Audit**',
      '**Strict**',
      'single-process',
      'not an official DeepSeek',
      'not human review',
      'source is public at',
      'zero-patch Strict',
      'lifetime fuse',
      'dsh-turn-budget',
      'pnpm release:evidence',
    ]) {
      expect(english.toLowerCase()).toContain(phrase.toLowerCase())
    }
    for (const phrase of [
      '共享生命周期准入协议',
      '参考策略内核',
      'Discussion #131',
      '**Audit**',
      '**Strict**',
      '单进程',
      '不是 DeepSeek 官方组件',
      '不是人工评审',
      '公开源码仓库',
      'zero-patch',
      'lifetime fuse',
      'dsh-turn-budget',
      'pnpm release:evidence',
    ]) {
      expect(chinese).toContain(phrase)
    }
    expect(`${english}\n${chinese}`).not.toMatch(/official(?:ly)? endorsed|官方背书的插件/i)
  })

  it('pins the exact source, protocol, patch, and source/npm divergence', () => {
    const baseline = json('compatibility/baseline.json')
    const patchHash = sha256('patches/dsh-subagent-admission-seam.patch')
    expect(baseline.source.commit).toBe('47f943859bef60e4160492346772ded9b24f765a')
    expect(baseline.source.packageVersion).toBe('0.1.0-rc.5')
    expect(baseline.npm['@deepseek-ai/dsh'].next).toBe('0.1.0-rc.6')
    expect(baseline.status).toBe('source-npm-diverged')
    expect(baseline.strictTargets).toEqual([expect.objectContaining({
      protocolVersion: 1,
      patchSha256: patchHash,
    })])
    for (const relativePath of [
      'README.md',
      'README.zh-CN.md',
      'docs/compatibility.md',
      'docs/upstream-seam.md',
    ]) {
      const contents = text(relativePath)
      expect(contents, relativePath).toContain(baseline.source.commit)
      expect(contents, relativePath).toContain(patchHash)
    }
  })

  it('acknowledges close precedents without retaining superseded claims', () => {
    const audit = text('compatibility/ecosystem-audit.md')
    expect(audit).toContain('fdcca3dbd9ff35b618d10e2c686c3f4c79bf3313')
    expect(audit).toContain('aace29c267b798a014be030768b85f5a2fc73818')
    expect(audit).toContain('30597c014b1c2bba8bd2d4a340ebc18949039c63')
    expect(audit).toContain('9583ad34682455a0d9be3bc35ec809908e21d1d2')
    expect(audit).toContain('dsh-turn-budget@0.1.0')
    expect(audit).toContain('Comments: 4 API rows')
    expect(audit).toContain('Reframe v2')
    expect(audit).toContain('current own-tool count/check path is not racy')
    expect(audit).toContain('complementary and composable')
    expect(audit).toContain('607 patch lines')
    expect(audit).toContain('mandatory, monotonic lifetime fuse')
    expect(audit).not.toContain('topic:dsh-plugin` repositories: `605')
    expect(audit).not.toContain('Total comments (REST) | `2`')
  })

  it('keeps package documents and licence byte-identical to root', () => {
    for (const filename of [
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      expect(readFileSync(pathOf(`packages/dsh-subagent-admission/${filename}`)))
        .toEqual(readFileSync(pathOf(filename)))
    }
    expect(text('LICENSE')).toContain('Copyright (c) 2026 Haorui Yu')
    expect(text('LICENSE')).toContain('MIT License')
  })

  it('packs only explicit documentation and generated runtime faces', () => {
    const manifest = json('packages/dsh-subagent-admission/package.json')
    expect(manifest.description).toContain('Shared lifecycle admission protocol')
    expect(manifest.author).toEqual({
      name: 'Haorui Yu',
      url: 'https://github.com/yha9806',
    })
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/yha9806/dsh-subagent-admission.git',
    })
    expect(manifest.bugs.url).toBe('https://github.com/yha9806/dsh-subagent-admission/issues')
    expect(manifest.homepage).toBe('https://github.com/yha9806/dsh-subagent-admission#readme')
    expect(manifest.publishConfig).toEqual({ access: 'public' })
    expect(manifest.files).toEqual([
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
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
    expect(manifest.files).not.toContain('lib')
    expect(manifest.files).not.toContain('src')
  })

  it('defines a bounded security policy and third-party provenance', () => {
    const security = text('SECURITY.md')
    for (const heading of [
      '## System and Scope',
      '## Threat Model and Trust Boundaries',
      '## Security Invariants',
      '## Reportable Findings and Severity Context',
      '## Out of Scope and Accepted Risk',
      '## Known Limitations and Compensating Controls',
    ]) expect(security).toContain(heading)
    expect(security).toContain('Audit mode must always report `enforced: false`')
    expect(security).toContain('malicious in-process plugin')
    expect(security).not.toMatch(/api[_ -]?key\s*[:=]\s*\S+/i)

    const notices = text('THIRD_PARTY_NOTICES.md')
    expect(notices).toContain('Copyright (c) 2026 DeepSeek')
    expect(notices).toContain('Copyright (c) 2025 Colin McDonnell')
    expect(notices).toContain('not copied into or distributed')
  })

  it('promotes exactly one native 1440x900 GUI image', () => {
    const screenshot = 'docs/assets/admission-control.png'
    expect(pngDimensions(screenshot)).toEqual({ width: 1440, height: 900 })
    const english = text('README.md')
    const chinese = text('README.zh-CN.md')
    expect(english).toContain(`![Admission Control view](${screenshot})`)
    expect(chinese).toContain(`![Admission Control 界面](${screenshot})`)
  })

  it('exposes reproducible docs and evidence commands', () => {
    const manifest = json('package.json')
    expect(manifest.scripts).toMatchObject({
      'docs:sync': 'tsx scripts/sync-package-docs.mts',
      'docs:check': 'tsx scripts/sync-package-docs.mts --check && vitest run tests/docs.spec.ts',
      'release:evidence': 'tsx scripts/release-evidence.mts --collect --promote-screenshot',
      'release:evidence:check': 'tsx scripts/release-evidence.mts --check',
    })
    expect(text('docs/reproduction.md')).toContain('pnpm release:evidence:check')
    expect(text('docs/compatibility.md')).toContain('Workflow configuration is not evidence')
    expect(text('docs/compatibility.md')).toContain('zero-patch Strict')
  })
})
