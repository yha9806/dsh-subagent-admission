#!/usr/bin/env tsx
/** Compose and verify Strict on the pinned patch plus Audit on stock npm rc.6. */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_RESULT_IDS } from '../tests/conformance/matrix.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const BASELINE_PATH = resolve(WORKSPACE_ROOT, 'compatibility/baseline.json')
const PATCH_PATH = resolve(WORKSPACE_ROOT, 'patches/dsh-subagent-admission-seam.patch')
const PACKAGE_PATH = resolve(
  WORKSPACE_ROOT,
  'packages/dsh-subagent-admission/package.json',
)
const OFFICIAL_TEST_DIR = 'packages/subagent/subagent/tests/admission-conformance'
const STOCK_SOURCE = resolve(
  WORKSPACE_ROOT,
  'tests/conformance/stock-audit.e2e.ts',
)
const STOCK_GENERATED = resolve(
  WORKSPACE_ROOT,
  'packages/dsh-subagent-admission/.cache/stock-audit.e2e.ts',
)
const STOCK_TSCONFIG = resolve(
  WORKSPACE_ROOT,
  'packages/dsh-subagent-admission/.cache/stock-audit.tsconfig.json',
)
const STRICT_SOURCES = [
  'tests/conformance/matrix.ts',
  'tests/conformance/lifecycle-barriers.ts',
  'tests/conformance/fake-provider.ts',
  'tests/conformance/strict-runtime.e2e.ts',
] as const

interface Baseline {
  readonly schemaVersion: 1
  readonly source: {
    readonly repository: string
    readonly commit: string
    readonly packagePath: string
    readonly packageVersion: string
  }
  readonly strictTargets: readonly {
    readonly sourceCommit: string
    readonly sourcePackageVersion: string
    readonly protocolVersion: number
  }[]
}

interface CommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

interface CliOptions {
  readonly output?: string
}

function parseCli(argv: readonly string[]): CliOptions {
  let output: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--output' || output !== undefined) {
      fail('usage: run-strict-conformance.mts [--output <path>]')
    }
    output = argv[++index]
    if (output === undefined || output.length === 0) {
      fail('--output needs a path')
    }
  }
  return output === undefined ? {} : { output }
}

function fail(message: string): never {
  throw new Error(`strict conformance: ${message}`)
}

function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, CI: '1' },
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error !== undefined) {
    fail(`${executable} could not start: ${result.error.message}`)
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (stdout.length > 0) process.stdout.write(stdout)
  if (stderr.length > 0) process.stderr.write(stderr)
  return { status: result.status ?? 1, stdout, stderr }
}

function checked(
  executable: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = command(executable, args, cwd, env)
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`)
  return result
}

function quiet(executable: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${executable} ${args.join(' ')} failed`)
  }
  return (result.stdout ?? '').trim()
}

function parseBaseline(): Baseline {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  if (
    parsed.schemaVersion !== 1 ||
    parsed.source.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git' ||
    !/^[0-9a-f]{40}$/.test(parsed.source.commit) ||
    !parsed.strictTargets.some((target) =>
      target.sourceCommit === parsed.source.commit &&
      target.sourcePackageVersion === parsed.source.packageVersion &&
      target.protocolVersion === 1,
    )
  ) {
    fail('baseline does not name one verified protocol-v1 target')
  }
  return parsed
}

function ensureExactCheckout(baseline: Baseline): string {
  const parent = resolve(WORKSPACE_ROOT, '.cache/deepseek-harness')
  const checkout = resolve(parent, baseline.source.commit)
  mkdirSync(parent, { recursive: true })
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
  if (quiet('git', ['status', '--porcelain'], checkout).length > 0) {
    fail('cached official checkout is dirty')
  }
  const current = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: checkout,
    encoding: 'utf8',
  })
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
  if (quiet('git', ['rev-parse', 'HEAD'], checkout) !== baseline.source.commit) {
    fail('official checkout identity mismatch')
  }
  return checkout
}

function assertDisposable(path: string): void {
  const fromTmp = relative(tmpdir(), path)
  if (
    !isAbsolute(path) ||
    isAbsolute(fromTmp) ||
    fromTmp.startsWith('..') ||
    !path.startsWith(join(tmpdir(), 'dsh-strict-conformance-'))
  ) {
    fail(`refusing to clean non-disposable path ${path}`)
  }
}

function packedPluginPath(): string {
  const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
    readonly name: string
    readonly version: string
  }
  const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  return resolve(WORKSPACE_ROOT, 'dist', filename)
}

function parseJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) fail(`missing evidence ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function writeTypecheckConfig(
  path: string,
  extendsPath: string,
  files: readonly string[],
): void {
  writeFileSync(path, `${JSON.stringify({
    extends: extendsPath,
    compilerOptions: {
      allowImportingTsExtensions: true,
      composite: false,
      declaration: false,
      declarationMap: false,
      incremental: false,
      noEmit: true,
    },
    files,
  }, null, 2)}\n`)
}

function validateStrict(path: string): number {
  const document = parseJson(path)
  if (document.schemaVersion !== 1 || !Array.isArray(document.rows)) {
    fail('strict evidence has an invalid schema')
  }
  const rows = document.rows as Array<{ readonly id?: unknown; readonly status?: unknown }>
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (rows.length !== REQUIRED_RESULT_IDS.length || byId.size !== rows.length) {
    fail('strict evidence has missing or duplicate result rows')
  }
  for (const id of REQUIRED_RESULT_IDS) {
    const row = byId.get(id)
    if (row === undefined) fail(`strict evidence omitted ${id}`)
    if (row.status !== 'pass') fail(`strict evidence did not pass ${id}`)
  }
  return rows.length
}

function validateStock(path: string): void {
  const document = parseJson(path)
  if (
    document.schemaVersion !== 1 ||
    document.status !== 'pass' ||
    document.runtimePackageVersion !== '0.1.0-rc.6' ||
    document.mode !== 'audit' ||
    document.enforced !== false ||
    document.concurrentChildrenAccepted !== 7 ||
    document.policySurfacePresent !== false
  ) {
    fail('stock Audit evidence does not prove the non-enforcing rc.6 fixture')
  }
}

let checkout = ''
let disposable = ''
let evidenceDir = ''
const cli = parseCli(process.argv.slice(2))

try {
  const baseline = parseBaseline()
  checkout = ensureExactCheckout(baseline)
  checked('git', ['apply', '--check', PATCH_PATH], checkout, 'patch preflight')

  const pnpm = process.env.DSH_PNPM_BIN ?? 'pnpm'
  checked(pnpm, ['pack:plugin'], WORKSPACE_ROOT, 'build and pack plugin')
  const tarball = packedPluginPath()
  if (!existsSync(tarball)) fail(`packed plugin missing at ${tarball}`)

  evidenceDir = mkdtempSync(join(tmpdir(), 'dsh-strict-conformance-evidence-'))
  mkdirSync(dirname(STOCK_GENERATED), { recursive: true })
  copyFileSync(STOCK_SOURCE, STOCK_GENERATED)
  writeTypecheckConfig(
    STOCK_TSCONFIG,
    '../../../tsconfig.base.json',
    ['./stock-audit.e2e.ts'],
  )
  checked(
    pnpm,
    ['exec', 'tsc', '-p', STOCK_TSCONFIG, '--pretty', 'false'],
    WORKSPACE_ROOT,
    'typecheck stock Audit fixture',
  )
  checked(
    pnpm,
    ['exec', 'vitest', 'run', STOCK_GENERATED, '--config', 'vitest.e2e.config.ts'],
    WORKSPACE_ROOT,
    'stock npm rc.6 Audit conformance',
    {
      DSH_ADMISSION_EVIDENCE_DIR: evidenceDir,
      DSH_STOCK_AUDIT_COMPOSED: '1',
    },
  )
  validateStock(join(evidenceDir, 'stock-audit.json'))

  disposable = mkdtempSync(join(tmpdir(), 'dsh-strict-conformance-'))
  assertDisposable(disposable)
  rmSync(disposable, { recursive: true })
  checked(
    'git',
    ['worktree', 'add', '--detach', disposable, baseline.source.commit],
    checkout,
    'create disposable official checkout',
  )
  checked('git', ['apply', PATCH_PATH], disposable, 'apply protocol-v1 patch')

  checked(
    pnpm,
    ['install', '--frozen-lockfile', '--ignore-scripts'],
    disposable,
    'install official lockfile',
  )
  checked(
    pnpm,
    ['build:lib:host'],
    disposable,
    'build official Host workspace packages',
  )
  checked(
    pnpm,
    [
      'add',
      '-Dw',
      '--ignore-scripts',
      '--config.auto-install-peers=false',
      tarball,
      '@deepseek-ai/cordis@workspace:*',
      '@deepseek-ai/dsh@workspace:*',
      '@deepseek-ai/dsh-api-remotes@workspace:*',
      '@deepseek-ai/dsh-client-locale@workspace:*',
      '@deepseek-ai/dsh-client-runtime@workspace:*',
      '@deepseek-ai/dsh-client-ui-conversation@workspace:*',
      '@deepseek-ai/dsh-session@workspace:*',
      '@deepseek-ai/dsh-session-persistence@workspace:*',
      '@deepseek-ai/dsh-storage-domain@workspace:*',
      '@deepseek-ai/dsh-subagent@workspace:*',
      '@deepseek-ai/dsh-typert-protocol@workspace:*',
      'react@18.2.0',
    ],
    disposable,
    'install packed admission plugin',
  )
  const officialDestination = resolve(disposable, OFFICIAL_TEST_DIR)
  mkdirSync(officialDestination, { recursive: true })
  for (const source of STRICT_SOURCES) {
    copyFileSync(
      resolve(WORKSPACE_ROOT, source),
      resolve(officialDestination, source.split('/').at(-1)!),
    )
  }
  checked(
    pnpm,
    ['exec', 'tsc', '-b', 'tsconfig.host.json', '--pretty', 'false'],
    disposable,
    'typecheck Strict conformance fixture in the official Host graph',
  )
  const strictTest = `${OFFICIAL_TEST_DIR}/strict-runtime.e2e.ts`
  checked(
    pnpm,
    [
      'exec',
      'vitest',
      'run',
      strictTest,
      '--config',
      'vitest.e2e.config.ts',
      '--reporter',
      'verbose',
      '--testTimeout',
      '30000',
      '--retry',
      '0',
    ],
    disposable,
    'patched exact-checkout Strict conformance',
    {
      DSH_ADMISSION_EVIDENCE_DIR: evidenceDir,
      DSH_ADMISSION_PATCHED_CHECKOUT: '1',
    },
  )
  const rows = validateStrict(join(evidenceDir, 'strict-runtime.json'))

  const summary = {
    schemaVersion: 1,
    status: 'pass',
    sourceCommit: baseline.source.commit,
    sourcePackageVersion: baseline.source.packageVersion,
    stockPackageVersion: '0.1.0-rc.6',
    strictResults: rows,
    stockAudit: 'pass-non-enforcing',
    evidenceDir,
    node: process.version,
    pnpm: quiet(pnpm, ['--version'], WORKSPACE_ROOT),
  }
  const rendered = `${JSON.stringify(summary, null, 2)}\n`
  if (cli.output !== undefined) {
    const outputPath = resolve(cli.output)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, rendered)
  }
  process.stdout.write(rendered)
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  if (evidenceDir.length > 0) console.error(`evidence directory: ${evidenceDir}`)
  process.exitCode = 1
} finally {
  rmSync(STOCK_GENERATED, { force: true })
  rmSync(STOCK_TSCONFIG, { force: true })
  if (disposable.length > 0 && checkout.length > 0) {
    assertDisposable(disposable)
    command('git', ['worktree', 'remove', '--force', disposable], checkout)
    rmSync(disposable, { recursive: true, force: true })
  }
}
