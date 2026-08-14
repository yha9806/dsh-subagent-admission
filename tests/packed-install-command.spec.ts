import { describe, expect, it } from 'vitest'

import {
  resolveCommandInvocation,
  resolvePnpmExecutable,
} from '../scripts/packed-install.mts'

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
