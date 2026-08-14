import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  parsePackedInstallCli,
  resolveCommandInvocation,
  resolvePnpmExecutable,
  type PackedInstallOptions,
} from '../scripts/packed-install.mts'
import {
  DEFAULT_SEAM_PATCH,
  type SeamPatchName,
} from '../scripts/seam-patch-tooling.js'

describe('packed-install pnpm executable', () => {
  it('uses the Windows command shim on win32', () => {
    expect(resolvePnpmExecutable({}, 'win32')).toBe('pnpm.cmd')
  })

  it('uses the POSIX executable on non-Windows platforms', () => {
    expect(resolvePnpmExecutable({}, 'darwin')).toBe('pnpm')
    expect(resolvePnpmExecutable({}, 'linux')).toBe('pnpm')
  })

  it('honours an explicit non-empty executable override', () => {
    expect(resolvePnpmExecutable({ DSH_PNPM_BIN: '/tooling/pnpm-wrapper' }, 'win32'))
      .toBe('/tooling/pnpm-wrapper')
  })

  it('runs Windows command shims through ComSpec instead of spawning them directly', () => {
    expect(resolveCommandInvocation(
      'pnpm.cmd',
      ['pack:plugin'],
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      'win32',
    )).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'pack:plugin'],
    })
  })
})

describe('packed-install seam patch selection', () => {
  it('types strictPatch on PackedInstallOptions using SeamPatchName', () => {
    expectTypeOf<PackedInstallOptions['strictPatch']>().toEqualTypeOf<
      SeamPatchName | undefined
    >()
    const options: PackedInstallOptions = { strictPatch: 'slim' }
    expect(options.strictPatch).toBe('slim')
    const refOptions: PackedInstallOptions = { strictPatch: 'reference' }
    expect(refOptions.strictPatch).toBe('reference')
  })

  it('resolves slim as the default seam patch after promotion', () => {
    expect(DEFAULT_SEAM_PATCH).toBe('slim')
  })

  it('parses explicit reference and slim --strict-patch arguments', () => {
    expect(
      parsePackedInstallCli(['--strict-patch', 'reference']).run.strictPatch,
    ).toBe('reference')
    expect(
      parsePackedInstallCli(['--strict-patch', 'slim']).run.strictPatch,
    ).toBe('slim')
  })

  it('rejects invalid patch names through parseSeamPatchName', () => {
    expect(() => parsePackedInstallCli(['--strict-patch', 'candidate'])).toThrow(
      'patch must be reference or slim',
    )
    expect(() => parsePackedInstallCli(['--strict-patch', ''])).toThrow(
      'patch must be reference or slim',
    )
  })

  it('rejects missing value for --strict-patch', () => {
    expect(() => parsePackedInstallCli(['--strict-patch'])).toThrow(
      /--strict-patch/i,
    )
  })
})
