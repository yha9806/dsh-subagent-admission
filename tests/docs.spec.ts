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
      'docs/upstream-agent-note.md',
      'docs/discussion-131-draft.md',
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
    const patchHash = sha256('patches/dsh-subagent-admission-seam-slim.patch')
    expect(baseline.source.commit).toBe('47f943859bef60e4160492346772ded9b24f765a')
    expect(baseline.source.packageVersion).toBe('0.1.0-rc.5')
    expect(baseline.npm['@deepseek-ai/dsh'].next).toBe('0.1.0-rc.6')
    expect(baseline.status).toBe('source-npm-diverged')
    expect(baseline.strictTargets).toEqual([expect.objectContaining({
      protocolVersion: 1,
      patchSha256: patchHash,
      verificationCommand: 'corepack pnpm tsx scripts/verify-seam-patch.mts --patch slim',
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

  it('packages the proposed Agent Note for upstream extension-point review', () => {
    const note = text('docs/upstream-agent-note.md')
    expect(note.startsWith('Status: proposed\n')).toBe(true)
    for (const heading of [
      '# Optional lifecycle-owned subagent admission',
      '## Problem',
      '## Alternatives considered',
      '## Decision',
      '## Protocol',
      '## Lifecycle boundaries',
      '## Cancellation and failure semantics',
      '## Testing',
      '## Consequences',
      '## Deferred work',
    ]) {
      expect(note).toContain(heading)
    }

    for (const term of [
      'Service Definition',
      'Provider',
      'Consumer',
      'acquire',
      'bindChild',
      'startup-failed',
      'quiescent',
      'cancellation',
      'tombstone',
      'ADMISSION_CLOSED',
      'zero-patch Strict',
      '47f943859bef60e4160492346772ded9b24f765a',
      '0.1.0-rc.5',
      'registerContinuableSetup',
      'Cordis waterfall',
    ]) {
      expect(note).toContain(term)
    }

    // Ensure exclusions
    expect(note.toLowerCase()).not.toMatch(/hiring|employment|salary|job application|recruitment/)
    expect(note).not.toContain('ledger')
    expect(note).not.toContain('perRootAdmittedTotal')
  })

  it('packages the published Discussion #131 reply source without claiming adoption', () => {
    const draft = text('docs/discussion-131-draft.md')
    expect(draft).toContain('independent')
    expect(draft).toContain('experimental')
    expect(draft).toContain('56')
    expect(draft).toContain('4')
    expect(draft).toContain('5')
    expect(draft).toContain('47')
    expect(draft).toContain('dsh-turn-budget')
    expect(draft).toContain('https://github.com/yha9806/dsh-subagent-admission')
    expect(draft).toContain('https://github.com/yha9806/dsh-subagent-admission/blob/main/docs/reproduction.md')
    expect(draft).toContain('https://github.com/yha9806/dsh-subagent-admission/blob/main/docs/upstream-agent-note.md')
    expect(draft).toContain('https://github.com/Nunchakus888/dsh-turn-budget')

    // Exactly one question
    const questions = draft.match(/\?/g) ?? []
    expect(questions.length).toBe(1)
    expect(draft).toContain('Would this optional lifecycle-owned admission registration on ctx.subagents fit as a documented extension point?')

    // Exclude markdown link destinations for word counting
    const textWithoutLinks = draft
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim()
    const words = textWithoutLinks.split(/\s+/).filter(Boolean)
    expect(words.length).toBeGreaterThanOrEqual(150)
    expect(words.length).toBeLessThanOrEqual(180)

    // No prohibited language
    expect(draft.toLowerCase()).not.toMatch(/pull request|please merge|hire me|job|resume|cv|maintainer|@deepseek/)
    expect(draft.toLowerCase()).not.toMatch(/endorsed|officially adopted|merged/)
  })

  it('documents both canonical reference and qualified slim candidate in docs and READMEs', () => {
    for (const file of ['README.md', 'README.zh-CN.md', 'docs/upstream-seam.md', 'docs/compatibility.md']) {
      const content = text(file)
      expect(content).toContain('1340a9ffabde8310f68a7d66c4dacecda5dba263dd51666740801f5ec2c69135')
      expect(content).toContain('1a3e351cab75ff22d55b0d2a8cb458cbee2794a769cb2f433e105dd421636073')
      expect(content).toContain('dsh-turn-budget')
    }
  })
})
