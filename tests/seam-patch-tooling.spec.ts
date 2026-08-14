import { describe, expect, it } from 'vitest'

import {
  assertSlimPatchMetrics,
  parseGitNumstat,
  parseSeamPatchName,
  seamPatch,
  summarizePatch,
} from '../scripts/seam-patch-tooling.js'

describe('seam patch tooling', () => {
  it('resolves only the two named artifacts', () => {
    expect(parseSeamPatchName('reference')).toBe('reference')
    expect(parseSeamPatchName('slim')).toBe('slim')
    expect(() => parseSeamPatchName('candidate')).toThrow(
      'patch must be reference or slim',
    )
    expect(() => parseSeamPatchName('')).toThrow(
      'patch must be reference or slim',
    )
    expect(() => parseSeamPatchName(undefined)).toThrow(
      'patch must be reference or slim',
    )
    expect(seamPatch('reference').relativePath)
      .toBe('patches/dsh-subagent-admission-seam.patch')
    expect(seamPatch('slim').relativePath)
      .toBe('patches/dsh-subagent-admission-seam-slim.patch')
  })

  it('measures changed and serialized lines without guessing', () => {
    const rows = parseGitNumstat([
      '100\t20\tpackages/subagent/subagent/src/continuation.ts',
      '120\t10\tpackages/subagent/subagent/src/index.ts',
      '40\t0\tpackages/subagent/subagent/src/types.ts',
    ].join('\n'))
    const metrics = summarizePatch(rows, 450)
    expect(metrics).toEqual({
      files: 3,
      insertions: 260,
      deletions: 30,
      changedLines: 290,
      continuationChangedLines: 120,
      serializedPatchLines: 450,
    })
    expect(() => assertSlimPatchMetrics(metrics)).not.toThrow()
  })

  it('rejects binary, malformed, duplicate, or unexpected numstat rows loud', () => {
    expect(() => parseGitNumstat('-\t-\tpackages/subagent/subagent/src/index.ts')).toThrow(
      /numstat/i,
    )
    expect(() => parseGitNumstat('10\tpackages/subagent/subagent/src/index.ts')).toThrow(
      /numstat/i,
    )
    expect(() => parseGitNumstat('abc\t10\tpackages/subagent/subagent/src/index.ts')).toThrow(
      /numstat/i,
    )
    expect(() => parseGitNumstat('10\t20\tpackages/other/src/index.ts')).toThrow(
      /official seam files|unexpected path|unapproved path/i,
    )
    expect(() => parseGitNumstat([
      '10\t20\tpackages/subagent/subagent/src/index.ts',
      '5\t2\tpackages/subagent/subagent/src/index.ts',
    ].join('\n'))).toThrow(
      /duplicate/i,
    )
  })

  it.each([
    [{ files: 4 }, 'official files 4 exceeds 3'],
    [{ changedLines: 314 }, 'changed lines 314 exceeds 313'],
    [{ continuationChangedLines: 141 }, 'continuation changed lines 141 exceeds 140'],
    [{ serializedPatchLines: 456 }, 'serialized patch lines 456 exceeds 455'],
  ])('rejects a failed slim threshold', (change, message) => {
    const metrics = {
      files: 3,
      insertions: 270,
      deletions: 30,
      changedLines: 300,
      continuationChangedLines: 130,
      serializedPatchLines: 440,
      ...change,
    }
    expect(() => assertSlimPatchMetrics(metrics)).toThrow(message)
  })
})
