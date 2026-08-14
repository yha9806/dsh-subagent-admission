#!/usr/bin/env tsx
/** Kill one exact Node child after durable admission, then verify restart truth. */

import { spawn, spawnSync } from 'node:child_process'
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Backend = 'json' | 'sqlite'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const PACKAGE_DIR = resolve(WORKSPACE_ROOT, 'packages/dsh-subagent-admission')
const GENERATED_DIR = resolve(PACKAGE_DIR, '.cache/crash')
const GENERATED_CHILD = resolve(GENERATED_DIR, 'child.mts')
const GENERATED_RESTART = resolve(GENERATED_DIR, 'restart.e2e.ts')

function fail(message: string): never {
  throw new Error(`crash fixture: ${message}`)
}

interface CliOptions {
  readonly backend: Backend
  readonly output?: string
}

function parseCli(argv: readonly string[]): CliOptions {
  let backend: Backend | undefined
  let output: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--backend' && backend === undefined) {
      const value = argv[++index]
      if (value !== 'json' && value !== 'sqlite') {
        fail('--backend must be json or sqlite')
      }
      backend = value
    } else if (argument === '--output' && output === undefined) {
      output = argv[++index]
      if (output === undefined || output.length === 0) {
        fail('--output needs a path')
      }
    } else {
      fail('usage: crash-fixture.mts --backend json|sqlite [--output <path>]')
    }
  }
  if (backend === undefined) {
    fail('usage: crash-fixture.mts --backend json|sqlite [--output <path>]')
  }
  return output === undefined ? { backend } : { backend, output }
}

function materialize(): void {
  mkdirSync(GENERATED_DIR, { recursive: true })
  copyFileSync(resolve(WORKSPACE_ROOT, 'tests/crash/child.mts'), GENERATED_CHILD)
  copyFileSync(
    resolve(WORKSPACE_ROOT, 'tests/crash/restart.e2e.ts'),
    GENERATED_RESTART,
  )
}

async function killAfterCommit(
  backend: Backend,
  root: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      GENERATED_CHILD,
      '--backend',
      backend,
      '--root',
      root,
    ],
    {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DSH_CRASH_CHILD_COMPOSED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let markerObserved = false
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new Error(
        `child did not emit LEDGER_COMMITTED within 20s; stderr=${stderr.slice(-2_000)}`,
      ))
    }, 20_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (!markerObserved && stdout.includes('LEDGER_COMMITTED\n')) {
        markerObserved = true
        if (!child.kill('SIGKILL') && !settled) {
          settled = true
          clearTimeout(timeout)
          rejectPromise(new Error('failed to send SIGKILL to the exact fixture child'))
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 128_000) stderr = stderr.slice(-128_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!markerObserved) {
        rejectPromise(new Error(
          `child exited before durable marker (code=${String(code)}, signal=${String(signal)}): ` +
          stderr.slice(-2_000),
        ))
        return
      }
      if (code !== null || signal !== 'SIGKILL') {
        rejectPromise(new Error(
          `child was not killed exactly by SIGKILL (code=${String(code)}, signal=${String(signal)})`,
        ))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function runRestart(
  backend: Backend,
  root: string,
  evidenceDir: string,
): void {
  const pnpm = process.env.DSH_PNPM_BIN ?? 'pnpm'
  const result = spawnSync(
    pnpm,
    [
      'exec',
      'vitest',
      'run',
      GENERATED_RESTART,
      '--config',
      'vitest.e2e.config.ts',
      '--reporter',
      'verbose',
      '--retry',
      '0',
    ],
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: '1',
        DSH_CRASH_COMPOSED: '1',
        DSH_CRASH_BACKEND: backend,
        DSH_CRASH_ROOT: root,
        DSH_ADMISSION_EVIDENCE_DIR: evidenceDir,
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  if ((result.stdout ?? '').length > 0) process.stdout.write(result.stdout)
  if ((result.stderr ?? '').length > 0) process.stderr.write(result.stderr)
  if (result.error !== undefined) {
    fail(`restart test could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`restart test failed with exit code ${String(result.status)}`)
  }
}

function validateEvidence(path: string, backend: Backend): Record<string, unknown> {
  if (!existsSync(path)) fail(`restart evidence missing at ${path}`)
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (
    document.schemaVersion !== 1 ||
    document.status !== 'pass' ||
    document.backend !== backend ||
    document.rootAdmittedTotal !== 1 ||
    document.rootRevision !== 1 ||
    document.globalActive !== 0 ||
    !Array.isArray(document.activeLeases) ||
    document.activeLeases.length !== 0 ||
    document.nextAdmissionCode !== 'ROOT_TOTAL_LIMIT'
  ) {
    fail('restart evidence does not prove cumulative persistence and lease reset')
  }
  return document
}

const cli = parseCli(process.argv.slice(2))
const backend = cli.backend
const root = mkdtempSync(join(tmpdir(), `dsh-crash-${backend}-`))
const evidencePath = join(root, `crash-${backend}.json`)

try {
  materialize()
  await killAfterCommit(backend, root)
  runRestart(backend, root, root)
  const restart = validateEvidence(evidencePath, backend)
  const result = {
    ...restart,
    crashMarker: 'LEDGER_COMMITTED',
    crashSignal: 'SIGKILL',
    exactChildProcess: true,
    evidenceDir: root,
    node: process.version,
  }
  const rendered = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(evidencePath, rendered)
  if (cli.output !== undefined) {
    const outputPath = resolve(cli.output)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, rendered)
  }
  process.stdout.write(rendered)
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`crash evidence directory: ${root}`)
  process.exitCode = 1
} finally {
  rmSync(GENERATED_DIR, { recursive: true, force: true })
}
