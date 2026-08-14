export type SeamPatchName = 'reference' | 'slim'

export const DEFAULT_SEAM_PATCH: SeamPatchName = 'slim'

export const OFFICIAL_SEAM_FILES = Object.freeze([
  'packages/subagent/subagent/src/continuation.ts',
  'packages/subagent/subagent/src/index.ts',
  'packages/subagent/subagent/src/types.ts',
] as const)

export interface SeamPatchDefinition {
  readonly name: SeamPatchName
  readonly relativePath: string
}

export interface PatchNumstatRow {
  readonly path: string
  readonly insertions: number
  readonly deletions: number
}

export interface PatchMetrics {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
  readonly changedLines: number
  readonly continuationChangedLines: number
  readonly serializedPatchLines: number
}

export function parseSeamPatchName(raw: unknown): SeamPatchName {
  if (raw === 'reference' || raw === 'slim') {
    return raw
  }
  throw new Error('patch must be reference or slim')
}

export function seamPatch(name: SeamPatchName): SeamPatchDefinition {
  if (name === 'reference') {
    return {
      name: 'reference',
      relativePath: 'patches/dsh-subagent-admission-seam.patch',
    }
  }
  if (name === 'slim') {
    return {
      name: 'slim',
      relativePath: 'patches/dsh-subagent-admission-seam-slim.patch',
    }
  }
  throw new Error(`unknown seam patch: ${String(name)}`)
}

export function parseGitNumstat(output: string): readonly PatchNumstatRow[] {
  const lines = output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const rows: PatchNumstatRow[] = []
  const seenPaths = new Set<string>()

  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length !== 3) {
      throw new Error(`malformed git numstat row: ${line}`)
    }
    const [rawInsertions, rawDeletions, path] = parts as [string, string, string]
    if (!/^\d+$/.test(rawInsertions) || !/^\d+$/.test(rawDeletions)) {
      throw new Error(`non-decimal counts in git numstat: ${line}`)
    }
    if (!(OFFICIAL_SEAM_FILES as readonly string[]).includes(path)) {
      throw new Error(`path outside official seam files: ${path}`)
    }
    if (seenPaths.has(path)) {
      throw new Error(`duplicate path in git numstat: ${path}`)
    }
    seenPaths.add(path)
    rows.push({
      path,
      insertions: Number.parseInt(rawInsertions, 10),
      deletions: Number.parseInt(rawDeletions, 10),
    })
  }

  return Object.freeze(rows)
}

export function summarizePatch(
  rows: readonly PatchNumstatRow[],
  serializedPatchLines: number,
): PatchMetrics {
  let insertions = 0
  let deletions = 0
  let continuationChangedLines = 0

  for (const row of rows) {
    insertions += row.insertions
    deletions += row.deletions
    if (row.path === 'packages/subagent/subagent/src/continuation.ts') {
      continuationChangedLines += row.insertions + row.deletions
    }
  }

  return {
    files: rows.length,
    insertions,
    deletions,
    changedLines: insertions + deletions,
    continuationChangedLines,
    serializedPatchLines,
  }
}

export function assertSlimPatchMetrics(metrics: PatchMetrics): void {
  if (metrics.files > 3) {
    throw new Error(`official files ${metrics.files} exceeds 3`)
  }
  if (metrics.changedLines > 313) {
    throw new Error(`changed lines ${metrics.changedLines} exceeds 313`)
  }
  if (metrics.continuationChangedLines > 140) {
    throw new Error(
      `continuation changed lines ${metrics.continuationChangedLines} exceeds 140`,
    )
  }
  if (metrics.serializedPatchLines > 455) {
    throw new Error(
      `serialized patch lines ${metrics.serializedPatchLines} exceeds 455`,
    )
  }
}
