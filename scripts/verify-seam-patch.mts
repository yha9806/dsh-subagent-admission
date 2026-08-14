#!/usr/bin/env tsx
/** Verify the protocol-v1 seam against one exact official source commit. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const BASELINE_PATH = resolve(WORKSPACE_ROOT, 'compatibility/baseline.json')
const PATCH_PATH = resolve(
  WORKSPACE_ROOT,
  'patches/dsh-subagent-admission-seam.patch',
)
const FIXTURE_PATH = resolve(
  WORKSPACE_ROOT,
  'tests/upstream/admission-policy.spec.ts',
)
const OFFICIAL_TEST_PATH =
  'packages/subagent/subagent/tests/admission-policy.spec.ts'
const CANONICAL_COMMAND =
  'corepack pnpm tsx scripts/verify-seam-patch.mts'
const TEST_COMMAND = [
  'exec',
  'vitest',
  'run',
  'packages/subagent/subagent/tests',
] as const

interface Baseline {
  readonly schemaVersion: 1
  readonly source: {
    readonly repository: string
    readonly commit: string
    readonly packagePath: string
    readonly packageVersion: string
  }
}

interface CommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

function fail(message: string): never {
  throw new Error(`seam verification: ${message}`)
}

function parseBaseline(): Baseline {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  if (
    parsed.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/.test(parsed.source?.commit ?? '') ||
    parsed.source.repository !==
      'https://github.com/deepseek-ai/deepseek-harness.git' ||
    parsed.source.packagePath !==
      'packages/subagent/subagent/package.json' ||
    typeof parsed.source.packageVersion !== 'string' ||
    parsed.source.packageVersion.length === 0
  ) {
    fail('compatibility baseline has no exact supported source identity')
  }
  return parsed
}

function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  options: { readonly print?: boolean } = {},
): CommandResult {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
    },
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error !== undefined) {
    fail(`${executable} could not start: ${result.error.message}`)
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (options.print ?? true) {
    if (stdout.length > 0) process.stdout.write(stdout)
    if (stderr.length > 0) process.stderr.write(stderr)
  }
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
  }
}

function checked(
  executable: string,
  args: readonly string[],
  cwd: string,
  label: string,
  options: { readonly print?: boolean } = {},
): CommandResult {
  const result = command(executable, args, cwd, options)
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status}`)
  }
  return result
}

function trimmed(
  executable: string,
  args: readonly string[],
  cwd: string,
): string {
  return checked(executable, args, cwd, executable, { print: false })
    .stdout.trim()
}

function assertDisposablePath(path: string): void {
  const relativePath = relative(tmpdir(), path)
  if (
    !isAbsolute(path) ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    !path.startsWith(join(tmpdir(), 'dsh-admission-seam-'))
  ) {
    fail(`refusing to clean non-disposable path ${path}`)
  }
}

function ensureExactCheckout(baseline: Baseline): string {
  const cacheParent = resolve(WORKSPACE_ROOT, '.cache/deepseek-harness')
  const checkout = resolve(cacheParent, baseline.source.commit)
  mkdirSync(cacheParent, { recursive: true })
  if (!existsSync(resolve(checkout, '.git'))) {
    mkdirSync(checkout, { recursive: true })
    checked('git', ['init'], checkout, 'initialize official checkout')
    checked(
      'git',
      ['remote', 'add', 'origin', baseline.source.repository],
      checkout,
      'configure official remote',
    )
  }
  const dirty = trimmed('git', ['status', '--porcelain'], checkout)
  if (dirty.length > 0) {
    fail(`cached official checkout is dirty:\n${dirty}`)
  }
  const current = command(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    checkout,
    { print: false },
  )
  if (current.status !== 0 || current.stdout.trim() !== baseline.source.commit) {
    checked(
      'git',
      ['fetch', '--depth=1', 'origin', baseline.source.commit],
      checkout,
      'fetch exact official commit',
    )
    checked(
      'git',
      ['checkout', '--detach', 'FETCH_HEAD'],
      checkout,
      'checkout exact official commit',
    )
  }
  if (trimmed('git', ['rev-parse', 'HEAD'], checkout) !== baseline.source.commit) {
    fail('cached official checkout HEAD does not match the baseline')
  }
  if (trimmed('git', ['status', '--porcelain'], checkout).length > 0) {
    fail('cached official checkout became dirty during identity verification')
  }
  const manifest = JSON.parse(
    readFileSync(resolve(checkout, baseline.source.packagePath), 'utf8'),
  ) as { readonly version?: unknown }
  if (manifest.version !== baseline.source.packageVersion) {
    fail(
      `source package version ${String(manifest.version)} does not match ` +
      `${baseline.source.packageVersion}`,
    )
  }
  return checkout
}

function verifyFixturePresent(): void {
  if (!existsSync(FIXTURE_PATH)) {
    fail(`missing reusable upstream fixture ${FIXTURE_PATH}`)
  }
}

function patchSha256(): string {
  return createHash('sha256').update(readFileSync(PATCH_PATH)).digest('hex')
}

const argument = process.argv[2]
if (
  argument !== undefined &&
  argument !== '--expect-unpatched-failure'
) {
  console.error(
    'usage: verify-seam-patch.mts [--expect-unpatched-failure]',
  )
  process.exit(2)
}

const expectUnpatchedFailure = argument === '--expect-unpatched-failure'
let checkout = ''
let disposable = ''

try {
  const baseline = parseBaseline()
  verifyFixturePresent()
  checkout = ensureExactCheckout(baseline)
  if (!expectUnpatchedFailure) {
    if (!existsSync(PATCH_PATH)) {
      fail(`missing seam patch ${PATCH_PATH}`)
    }
    checked(
      'git',
      ['apply', '--check', PATCH_PATH],
      checkout,
      'patch preflight',
    )
  }

  disposable = mkdtempSync(join(tmpdir(), 'dsh-admission-seam-'))
  assertDisposablePath(disposable)
  rmSync(disposable, { recursive: true })
  checked(
    'git',
    ['worktree', 'add', '--detach', disposable, baseline.source.commit],
    checkout,
    'create disposable exact checkout',
  )
  copyFileSync(FIXTURE_PATH, resolve(disposable, OFFICIAL_TEST_PATH))
  if (!expectUnpatchedFailure) {
    checked('git', ['apply', PATCH_PATH], disposable, 'apply seam patch')
  }

  const pnpm = process.env.DSH_PNPM_BIN ?? 'pnpm'
  checked(
    pnpm,
    ['install', '--frozen-lockfile', '--ignore-scripts'],
    disposable,
    'install official lockfile',
  )
  checked(
    pnpm,
    [
      'exec',
      'tsc',
      '-b',
      'packages/subagent/subagent/tsconfig.json',
      '--pretty',
      'false',
    ],
    disposable,
    'build official subagent package',
  )

  const test = command(pnpm, TEST_COMMAND, disposable)
  if (expectUnpatchedFailure) {
    if (test.status === 0) {
      fail('unpatched source unexpectedly passed the admission fixture')
    }
    const output = `${test.stdout}\n${test.stderr}`
    if (
      !output.includes('admissionProtocolVersion') &&
      !output.includes('registerAdmissionPolicy')
    ) {
      fail('unpatched failure did not identify the missing protocol-v1 surface')
    }
  } else if (test.status !== 0) {
    fail(`patched official subagent tests failed with exit code ${test.status}`)
  }

  const result = {
    schemaVersion: 1,
    status: expectUnpatchedFailure ? 'expected-failure' : 'pass',
    sourceCommit: baseline.source.commit,
    sourcePackageVersion: baseline.source.packageVersion,
    ...expectUnpatchedFailure ? {} : { patchSha256: patchSha256() },
    node: process.version,
    pnpm: trimmed(pnpm, ['--version'], disposable),
    command: CANONICAL_COMMAND,
    testCommand: `pnpm ${TEST_COMMAND.join(' ')}`,
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  if (disposable.length > 0 && checkout.length > 0) {
    assertDisposablePath(disposable)
    command(
      'git',
      ['worktree', 'remove', '--force', disposable],
      checkout,
    )
    rmSync(disposable, { recursive: true, force: true })
  }
}
