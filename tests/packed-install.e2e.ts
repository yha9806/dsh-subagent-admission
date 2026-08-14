import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  runPackedInstall,
  type PackedInstallReport,
} from '../scripts/packed-install.mts'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT_ONLY = process.env.DSH_PACKED_AUDIT_ONLY === '1'
const SHA256 = /^[0-9a-f]{64}$/

describe.sequential('packed DSH installation', () => {
  let report: PackedInstallReport

  beforeAll(async () => {
    report = await runPackedInstall({
      auditOnly: AUDIT_ONLY,
      captureGui: false,
      cleanup: true,
      workspaceRoot: WORKSPACE_ROOT,
    })
    const reportPath = process.env.DSH_PACKED_REPORT_PATH
    if (reportPath !== undefined) {
      const absoluteReportPath = resolve(WORKSPACE_ROOT, reportPath)
      mkdirSync(dirname(absoluteReportPath), { recursive: true })
      writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`)
    }
  }, 300_000)

  it('installs one absolute local tarball into an isolated web profile', () => {
    expect(report.schemaVersion).toBe(1)
    expect(report.status).toBe('pass')
    expect(isAbsolute(report.package.tarballPath)).toBe(true)
    expect(report.package.tarballSha256).toMatch(SHA256)
    expect(report.package.clientBundleSha256).toMatch(SHA256)
    expect(report.profile.dumpSha256).toMatch(SHA256)
    expect(report.environment).toMatchObject({
      node: expect.any(String),
      platform: expect.any(String),
      arch: expect.any(String),
      dshPackageVersion: '0.1.0-rc.6',
      stockSubagentPackageVersion: '0.1.0-rc.6',
    })

    const install = report.commands.find(command => command.name === 'profile-install')
    expect(install).toBeDefined()
    expect(install?.exitCode).toBe(0)
    expect(install?.args.slice(0, 6)).toEqual([
      'exec',
      'dsh',
      'plugin',
      '--profile',
      'web',
      'add',
    ])
    expect(install?.args.at(-1)).toBe(report.package.tarballPath)
    expect(isAbsolute(install!.args.at(-1)!)).toBe(true)
    expect(existsSync(report.temporaryRoot)).toBe(false)
  })

  it('dumps the installed bundle row and boots stock Audit honestly', () => {
    expect(report.profile.dump).toContain('# == dsh-subagent-admission')
    expect(report.profile.dump).toContain('id: subagent-admission')
    expect(report.audit.snapshot).toMatchObject({
      schemaVersion: 1,
      mode: 'audit',
      enforced: false,
      reason: 'audit-observation-only',
    })
    expect(report.audit.concurrentChildrenAccepted).toBe(7)
    expect(report.clientBoot.pluginIds).toContain('dsh-subagent-admission')
    expect(report.clientBoot.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  it.skipIf(AUDIT_ONLY)('denies the seventh global activation before provider work on the patched target', () => {
    expect(report.strict).toMatchObject({
      mode: 'strict',
      enforced: true,
      acceptedActivations: 6,
      attemptedActivations: 7,
      providerStarts: 6,
      deniedCode: 'GLOBAL_ACTIVE_LIMIT',
      activeByRootBeforeDenial: {
        'packed-root-a': 3,
        'packed-root-b': 3,
      },
    })
    expect(report.strict?.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.strict?.sourcePackageVersion).toBe('0.1.0-rc.5')
  })
})
