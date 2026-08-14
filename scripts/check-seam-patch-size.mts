#!/usr/bin/env tsx
/** Measure and optionally enforce subagent seam patch metrics. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertSlimPatchMetrics,
  parseGitNumstat,
  parseSeamPatchName,
  seamPatch,
  summarizePatch,
  type PatchMetrics,
  type SeamPatchName,
} from './seam-patch-tooling.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')

interface PatchSizeReport {
  readonly schemaVersion: 1
  readonly status: 'measured'
  readonly patch: SeamPatchName
  readonly patchPath: string
  readonly patchSha256: string
  readonly metrics: PatchMetrics
  readonly slimQualified: boolean
}

function countSerializedLines(content: string): number {
  if (content.length === 0) return 0
  const lines = content.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function parseArgs(args: readonly string[]): {
  readonly patch: SeamPatchName
  readonly enforceSlim: boolean
} {
  let patch: SeamPatchName | undefined
  let enforceSlim = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--patch') {
      i++
      if (i >= args.length) {
        throw new Error('missing value for --patch')
      }
      patch = parseSeamPatchName(args[i])
    } else if (arg === '--enforce-slim') {
      enforceSlim = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (patch === undefined) {
    throw new Error('missing required argument: --patch <reference|slim>')
  }
  if (enforceSlim && patch !== 'slim') {
    throw new Error('--enforce-slim is only supported with --patch slim')
  }

  return { patch, enforceSlim }
}

try {
  const { patch, enforceSlim } = parseArgs(process.argv.slice(2))
  const definition = seamPatch(patch)
  const patchAbsolutePath = resolve(WORKSPACE_ROOT, definition.relativePath)

  if (!existsSync(patchAbsolutePath)) {
    throw new Error(`missing seam patch file ${definition.relativePath}`)
  }

  const patchBytes = readFileSync(patchAbsolutePath)
  const patchSha256 = createHash('sha256').update(patchBytes).digest('hex')
  if (!/^[0-9a-f]{64}$/.test(patchSha256)) {
    throw new Error(`invalid patch SHA-256: ${patchSha256}`)
  }

  const serializedPatchLines = countSerializedLines(patchBytes.toString('utf8'))

  const gitNumstat = spawnSync(
    'git',
    ['apply', '--numstat', patchAbsolutePath],
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
    },
  )
  if (gitNumstat.error !== undefined) {
    throw new Error(
      `git apply --numstat could not start: ${gitNumstat.error.message}`,
    )
  }
  if (gitNumstat.status !== 0) {
    throw new Error(
      `git apply --numstat failed with code ${gitNumstat.status}: ${gitNumstat.stderr}`,
    )
  }

  const rows = parseGitNumstat(gitNumstat.stdout ?? '')
  const metrics = summarizePatch(rows, serializedPatchLines)

  let slimQualified = false
  try {
    assertSlimPatchMetrics(metrics)
    slimQualified = true
  } catch {
    slimQualified = false
  }

  if (enforceSlim) {
    assertSlimPatchMetrics(metrics)
  }

  const report: PatchSizeReport = {
    schemaVersion: 1,
    status: 'measured',
    patch,
    patchPath: definition.relativePath,
    patchSha256,
    metrics,
    slimQualified,
  }

  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
