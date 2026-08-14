#!/usr/bin/env tsx
/** Keep npm package-facing release documents byte-identical to the root copy. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const PACKAGE_ROOT = resolve(WORKSPACE_ROOT, 'packages/dsh-subagent-admission')

const DOCUMENTS = Object.freeze([
  Object.freeze({ source: 'README.md', target: 'README.md' }),
  Object.freeze({ source: 'README.zh-CN.md', target: 'README.zh-CN.md' }),
  Object.freeze({ source: 'LICENSE', target: 'LICENSE' }),
  Object.freeze({ source: 'THIRD_PARTY_NOTICES.md', target: 'THIRD_PARTY_NOTICES.md' }),
])

export interface PackageDocsSyncResult {
  readonly checked: number
  readonly changed: readonly string[]
}

export function syncPackageDocs(checkOnly = false): PackageDocsSyncResult {
  const changed: string[] = []
  for (const document of DOCUMENTS) {
    const sourcePath = resolve(WORKSPACE_ROOT, document.source)
    const targetPath = resolve(PACKAGE_ROOT, document.target)
    const source = readFileSync(sourcePath)
    const target = existsSync(targetPath) ? readFileSync(targetPath) : undefined
    if (target !== undefined && source.equals(target)) continue
    changed.push(document.target)
    if (!checkOnly) {
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, source)
    }
  }
  return Object.freeze({
    checked: DOCUMENTS.length,
    changed: Object.freeze(changed),
  })
}

function parseCli(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  if (argv.length === 1 && argv[0] === '--check') return true
  throw new Error('usage: sync-package-docs.mts [--check]')
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const checkOnly = parseCli(process.argv.slice(2))
    const result = syncPackageDocs(checkOnly)
    if (checkOnly && result.changed.length > 0) {
      throw new Error(`package documents are stale: ${result.changed.join(', ')}`)
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      mode: checkOnly ? 'check' : 'write',
      ...result,
    }, null, 2)}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
