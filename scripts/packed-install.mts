#!/usr/bin/env tsx
/** Verify the packed plugin through an isolated real DSH profile. */

import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const TEMP_PREFIX = 'dsh-packed-install-'
const STRICT_TEMP_PREFIX = 'dsh-packed-strict-'
const MAX_COMMAND_BUFFER = 128 * 1024 * 1024
const WEB_START_TIMEOUT_MS = 90_000
const CHILD_STOP_TIMEOUT_MS = 15_000

export interface PackedCommandReport {
  readonly name: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stdoutSha256: string
  readonly stderrSha256: string
}

export interface PackedInstallReport {
  readonly schemaVersion: 1
  readonly status: 'pass'
  readonly temporaryRoot: string
  readonly environment: {
    readonly node: string
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly dshPackageVersion: string
    readonly stockSubagentPackageVersion: string
  }
  readonly package: {
    readonly tarballPath: string
    readonly tarballSha256: string
    readonly clientBundleSha256: string
  }
  readonly profile: {
    readonly dump: string
    readonly dumpSha256: string
  }
  readonly audit: {
    readonly snapshot: Record<string, unknown>
    readonly concurrentChildrenAccepted: number
  }
  readonly clientBoot: {
    readonly serverUrl: string
    readonly pluginIds: readonly string[]
  }
  readonly strict?: {
    readonly mode: 'strict'
    readonly enforced: true
    readonly acceptedActivations: number
    readonly attemptedActivations: number
    readonly providerStarts: number
    readonly deniedCode: 'GLOBAL_ACTIVE_LIMIT'
    readonly activeByRootBeforeDenial: Readonly<Record<string, number>>
    readonly sourceCommit: string
    readonly sourcePackageVersion: string
  }
  readonly gui?: {
    readonly screenshotPath: string
    readonly screenshotSha256: string
    readonly viewport: { readonly width: 1440; readonly height: 900 }
    readonly modeText: string
    readonly quotaCards: 4
    readonly activeTab: true
    readonly nativeTabsPresent: true
    readonly mutationControls: 0
  }
  readonly commands: readonly PackedCommandReport[]
}

export interface PackedInstallOptions {
  readonly auditOnly?: boolean
  readonly captureGui?: boolean
  readonly cleanup?: boolean
  readonly screenshotPath?: string
  readonly workspaceRoot?: string
}

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
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface WebProcess {
  readonly child: ChildProcess
  readonly serverUrl: string
  readonly stdout: () => string
  readonly stderr: () => string
}

interface AuditSeedEvidence {
  readonly schemaVersion: 1
  readonly status: 'pass'
  readonly concurrentChildrenAccepted: number
  readonly providerStarts: number
  readonly snapshot: Record<string, unknown>
}

function fail(message: string): never {
  throw new Error(`packed install: ${message}`)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function tail(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function recordCommand(
  commands: PackedCommandReport[],
  name: string,
  executable: string,
  args: readonly string[],
  cwd: string,
  result: CommandResult,
): void {
  commands.push(Object.freeze({
    name,
    executable,
    args: Object.freeze([...args]),
    cwd,
    exitCode: result.exitCode,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  }))
}

function command(
  commands: PackedCommandReport[],
  name: string,
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, CI: '1' },
    maxBuffer: MAX_COMMAND_BUFFER,
  })
  if (result.error !== undefined) {
    fail(`${name} could not start: ${result.error.message}`)
  }
  const normalized = {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
  recordCommand(commands, name, executable, args, cwd, normalized)
  return normalized
}

function checked(
  commands: PackedCommandReport[],
  name: string,
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = command(commands, name, executable, args, cwd, env)
  if (result.exitCode !== 0) {
    fail(`${name} failed with exit code ${result.exitCode}\n${tail(result.stderr || result.stdout)}`)
  }
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

function assertTemporaryRoot(path: string, prefix: string): void {
  const absoluteTmp = resolve(tmpdir())
  const absolute = resolve(path)
  const fromTmp = relative(absoluteTmp, absolute)
  if (
    !isAbsolute(path)
    || fromTmp.length === 0
    || isAbsolute(fromTmp)
    || fromTmp.startsWith('..')
    || !basename(absolute).startsWith(prefix)
  ) {
    fail(`refusing to clean non-disposable path ${path}`)
  }
}

function packageVersion(workspaceRoot: string, packageName: string): string {
  const require = createRequire(join(workspaceRoot, 'package.json'))
  const manifestPath = require.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`${packageName} has no package version`)
  }
  return manifest.version
}

function pluginTarballPath(workspaceRoot: string): string {
  const manifestPath = resolve(
    workspaceRoot,
    'packages/dsh-subagent-admission/package.json',
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly name: string
    readonly version: string
  }
  const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  return resolve(workspaceRoot, 'dist', filename)
}

function packedClientHash(tarballPath: string): string {
  const result = spawnSync(
    'tar',
    ['-xOf', tarballPath, 'package/lib/client.js'],
    { encoding: null, maxBuffer: MAX_COMMAND_BUFFER },
  )
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(`could not extract package/lib/client.js from ${tarballPath}`)
  }
  return sha256(result.stdout)
}

function parseBaseline(workspaceRoot: string): Baseline {
  const path = resolve(workspaceRoot, 'compatibility/baseline.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baseline
  if (
    parsed.schemaVersion !== 1
    || parsed.source.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || !/^[0-9a-f]{40}$/.test(parsed.source.commit)
    || !parsed.strictTargets.some(target =>
      target.sourceCommit === parsed.source.commit
      && target.sourcePackageVersion === parsed.source.packageVersion
      && target.protocolVersion === 1)
  ) {
    fail('baseline does not name one exact protocol-v1 target')
  }
  return parsed
}

function ensureExactCheckout(
  commands: PackedCommandReport[],
  workspaceRoot: string,
  baseline: Baseline,
): string {
  const parent = resolve(workspaceRoot, '.cache/deepseek-harness')
  const checkout = resolve(parent, baseline.source.commit)
  mkdirSync(parent, { recursive: true })
  if (!existsSync(resolve(checkout, '.git'))) {
    mkdirSync(checkout, { recursive: true })
    checked(commands, 'strict-cache-init', 'git', ['init'], checkout)
    checked(
      commands,
      'strict-cache-remote',
      'git',
      ['remote', 'add', 'origin', baseline.source.repository],
      checkout,
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
      commands,
      'strict-cache-fetch',
      'git',
      ['fetch', '--depth=1', 'origin', baseline.source.commit],
      checkout,
    )
    checked(
      commands,
      'strict-cache-checkout',
      'git',
      ['checkout', '--detach', 'FETCH_HEAD'],
      checkout,
    )
  }
  if (quiet('git', ['rev-parse', 'HEAD'], checkout) !== baseline.source.commit) {
    fail('official checkout identity mismatch')
  }
  return checkout
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) fail(`missing evidence ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function writeAuditSeed(
  temporaryRoot: string,
  workspaceRoot: string,
): { readonly overlayPath: string; readonly evidencePath: string } {
  const modulePath = resolve(temporaryRoot, 'packed-audit-seed.mjs')
  const overlayPath = resolve(temporaryRoot, 'packed-audit-seed.yml')
  const evidencePath = resolve(temporaryRoot, 'packed-audit.json')
  const source = [
    "import { writeFileSync } from 'node:fs'",
    '',
    "export const name = 'dsh-packed-audit-seed'",
    "export const inject = ['agentLoop', 'subagents', 'subagentAdmission']",
    '',
    'function deferred() {',
    '  let resolve',
    '  const promise = new Promise(done => { resolve = done })',
    '  return { promise, resolve }',
    '}',
    '',
    'export async function apply(ctx, config) {',
    '  const parent = ctx.agentLoop.create(config.sessionId, {}, { cwd: config.cwd })',
    "  parent.session.append('turn/start', { turn: 1 })",
    "  parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })",
    "  parent.session.append('session/title', {",
    "    title: 'Packed admission fixture',",
    "    messageSeqs: [],",
    "    source: { kind: 'user' },",
    '  })',
    '  const settlements = []',
    '  let starts = 0',
    '  const provider = {',
    "    name: 'packed-gui-held',",
    '    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },',
    '    inheritsParentContext: false,',
    '    async start() {',
    '      starts += 1',
    '      const settlement = deferred()',
    '      settlements.push(settlement)',
    '      return {',
    '        id: `packed-gui-child-${starts}`,',
    '        result: settlement.promise,',
    '        async dispose() {},',
    '      }',
    '    },',
    '  }',
    '  const unregister = ctx.subagents.registerProvider(provider)',
    '  let runs = []',
    '  try {',
    '    runs = await Promise.all(Array.from({ length: 7 }, (_, index) =>',
    '      ctx.subagents.start(provider.name, {',
    '        label: `packed audit child ${index + 1}`,',
    "        prompt: [{ type: 'text', text: 'hold' }],",
    '        parent,',
    '        signal: new AbortController().signal,',
    '      })))',
    '    const snapshot = ctx.subagentAdmission.currentSnapshot(config.sessionId)',
    '    writeFileSync(config.evidencePath, `${JSON.stringify({',
    '      schemaVersion: 1,',
    "      status: 'pass',",
    '      concurrentChildrenAccepted: runs.length,',
    '      providerStarts: starts,',
    '      snapshot,',
    "    }, null, 2)}\\n`)",
    '  } catch (error) {',
    '    unregister()',
    '    throw error',
    '  }',
    '  return async () => {',
    '    for (const settlement of settlements) {',
    "      settlement.resolve({ output: [{ type: 'text', text: 'complete' }], stopReason: 'completed' })",
    '    }',
    '    await Promise.all(runs.map(run => run.result))',
    '    await Promise.all(runs.map(run => run.dispose()))',
    '    unregister()',
    '  }',
    '}',
    '',
  ].join('\n')
  writeFileSync(modulePath, source)
  writeFileSync(overlayPath, [
    '- insert:',
    '    - id: packed-audit-seed',
    `      name: ${JSON.stringify(pathToFileURL(modulePath).href)}`,
    '      config:',
    `        sessionId: ${JSON.stringify('packed-gui-root')}`,
    `        cwd: ${JSON.stringify(workspaceRoot)}`,
    `        evidencePath: ${JSON.stringify(evidencePath)}`,
    '',
  ].join('\n'))
  return { overlayPath, evidencePath }
}

function parseClientBoot(html: string): readonly string[] {
  const marker = 'window.__DSH_BOOT__ = '
  const markerAt = html.indexOf(marker)
  if (markerAt < 0) fail('Web HTML omitted window.__DSH_BOOT__')
  const valueAt = markerAt + marker.length
  const scriptEnd = html.indexOf('</script>', valueAt)
  if (scriptEnd < 0) fail('Web HTML did not close the boot script')
  const source = html.slice(valueAt, scriptEnd).trim().replace(/;$/, '')
  const boot = JSON.parse(source) as {
    readonly entries?: readonly { readonly id?: unknown }[]
  }
  if (!Array.isArray(boot.entries)) fail('Web boot payload omitted entries')
  const ids = boot.entries.map(entry => entry.id).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  if (ids.length !== boot.entries.length) fail('Web boot payload has an invalid plugin id')
  return Object.freeze(ids)
}

async function waitForWeb(
  child: ChildProcess,
  readOutput: () => string,
): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < WEB_START_TIMEOUT_MS) {
    const output = readOutput()
    const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(output)
    if (match?.[1] !== undefined) {
      return match[1].endsWith('/') ? match[1] : `${match[1]}/`
    }
    if (child.exitCode !== null) {
      fail(`Web exited before readiness with code ${child.exitCode}\n${tail(output)}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  fail(`Web did not become ready within ${WEB_START_TIMEOUT_MS}ms\n${tail(readOutput())}`)
}

async function startWeb(
  pnpm: string,
  workspaceRoot: string,
  dshHome: string,
  overlayPath: string,
): Promise<WebProcess> {
  const args = [
    'exec',
    'dsh',
    '--profile',
    'web',
    '--patch',
    overlayPath,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]
  const child = spawn(pnpm, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CI: '1',
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'packed-install-no-model-call',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString() })
  const serverUrl = await waitForWeb(child, () => `${stdout}\n${stderr}`)
  return { child, serverUrl, stdout: () => stdout, stderr: () => stderr }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>(resolveClose => child.once('close', () => { resolveClose() }))
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<false>(resolveWait => setTimeout(
      () => { resolveWait(false) },
      CHILD_STOP_TIMEOUT_MS,
    )),
  ])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed
  }
}

async function waitForJson(path: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return readJson(path)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  fail(`timed out waiting for ${path}`)
}

function validateAudit(document: Record<string, unknown>): AuditSeedEvidence {
  const candidate = document as unknown as AuditSeedEvidence
  const snapshot = candidate.snapshot as {
    readonly schemaVersion?: unknown
    readonly mode?: unknown
    readonly enforced?: unknown
    readonly reason?: unknown
    readonly history?: unknown
  }
  if (
    candidate.schemaVersion !== 1
    || candidate.status !== 'pass'
    || candidate.concurrentChildrenAccepted !== 7
    || candidate.providerStarts !== 7
    || snapshot.schemaVersion !== 1
    || snapshot.mode !== 'audit'
    || snapshot.enforced !== false
    || snapshot.reason !== 'audit-observation-only'
    || !Array.isArray(snapshot.history)
    || snapshot.history.filter(event =>
      typeof event === 'object'
      && event !== null
      && (event as { kind?: unknown }).kind === 'accepted').length !== 7
  ) {
    fail('installed Audit seed evidence is incomplete or enforcing')
  }
  return candidate
}

async function captureGui(
  serverUrl: string,
  requestedPath: string,
): Promise<NonNullable<PackedInstallReport['gui']>> {
  const screenshotPath = resolve(requestedPath)
  mkdirSync(dirname(screenshotPath), { recursive: true })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      locale: 'en-GB',
    })
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('requestfailed', request => {
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`)
    })
    await page.goto(serverUrl, { waitUntil: 'load' })
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error: unknown) {
      const body = await page.locator('body').innerText().catch(() => '(body unavailable)')
      fail([
        error instanceof Error ? error.message : String(error),
        `body: ${tail(body, 2_000)}`,
        `page errors: ${pageErrors.join('; ') || '(none)'}`,
        `console errors: ${consoleErrors.join('; ') || '(none)'}`,
        `failed requests: ${failedRequests.join('; ') || '(none)'}`,
      ].join('\n'))
    }

    const firstRunContinue = page.getByRole('button', { name: 'Continue', exact: true })
    if (await firstRunContinue.isVisible().catch(() => false)) {
      await firstRunContinue.click()
      await firstRunContinue.waitFor({ state: 'hidden', timeout: 10_000 })
    }

    const admissionTab = page.getByRole('tab', { name: 'Admission Control' })
    if (await admissionTab.count() === 0) {
      const ungrouped = page.getByRole('treeitem').filter({ hasText: 'Ungrouped' }).first()
      if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
      const session = page.getByRole('treeitem')
        .filter({ hasText: /Packed admission fixture|packed-gui-root/ }).first()
      try {
        await session.waitFor({ timeout: 15_000 })
      } catch (error: unknown) {
        const body = await page.locator('body').innerText().catch(() => '(body unavailable)')
        const treeItems = await page.getByRole('treeitem').allInnerTexts().catch(() => [])
        fail([
          error instanceof Error ? error.message : String(error),
          `body: ${tail(body, 2_000)}`,
          `tree items: ${JSON.stringify(treeItems)}`,
        ].join('\n'))
      }
      await session.click()
    }
    await admissionTab.waitFor({ timeout: 15_000 })
    await admissionTab.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: 'Admission Control', level: 1 })
      .waitFor({ timeout: 15_000 })
    await page.getByRole('status').filter({ hasText: 'Audit' }).waitFor({ timeout: 15_000 })
    const quotaCards = await page.locator('[data-testid="quota-card"]').count()
    if (quotaCards !== 4) fail(`GUI rendered ${quotaCards} quota cards instead of four`)
    await page.getByRole('heading', { name: 'Active leases' }).waitFor()
    await page.getByRole('heading', { name: 'Admission history' }).waitFor()
    const historyRows = page.getByRole('table', { name: 'Admission history' }).locator('tbody tr')
    if (await historyRows.count() !== 8) fail('GUI did not render bootstrap plus seven accepted events')
    const nativeTabsPresent = await Promise.all(['Chat', 'Trajectory', 'Admission Control'].map(
      name => page.getByRole('tab', { name }).count(),
    )).then(counts => counts.every(count => count === 1))
    if (!nativeTabsPresent) fail('GUI displaced a native conversation tab')
    const mutationControls = await page.getByRole('button').filter({
      hasText: /Kill|Reset|Force release|Retry|Edit quota/i,
    }).count()
    if (mutationControls !== 0) fail('GUI exposed a mutation control')
    const activeTab = await admissionTab.getAttribute('aria-selected') === 'true'
      && await admissionTab.evaluate(element => document.activeElement === element)
    if (!activeTab) fail('Admission Control tab has no selected keyboard focus state')
    const geometry = await page.evaluate(() => {
      const rows = document.querySelectorAll('[aria-label="Admission history"] tbody tr')
      const lastRow = rows.item(rows.length - 1).getBoundingClientRect()
      const composer = document.querySelector('[data-composer-seat]')?.getBoundingClientRect()
      return {
        lastRowBottom: lastRow.bottom,
        composerTop: composer?.top ?? window.innerHeight,
        viewportHeight: window.innerHeight,
      }
    })
    if (geometry.lastRowBottom > Math.min(geometry.composerTop, geometry.viewportHeight)) {
      fail(`GUI history is clipped: row bottom ${geometry.lastRowBottom}, composer top ${geometry.composerTop}`)
    }
    if (pageErrors.length > 0 || consoleErrors.length > 0 || failedRequests.length > 0) {
      fail([
        `GUI page errors: ${pageErrors.join('; ') || '(none)'}`,
        `GUI console errors: ${consoleErrors.join('; ') || '(none)'}`,
        `GUI failed requests: ${failedRequests.join('; ') || '(none)'}`,
      ].join('\n'))
    }

    await page.screenshot({ path: screenshotPath })
    return {
      screenshotPath,
      screenshotSha256: sha256(readFileSync(screenshotPath)),
      viewport: { width: 1440, height: 900 },
      modeText: (await page.getByRole('status').innerText()).trim(),
      quotaCards: 4,
      activeTab: true,
      nativeTabsPresent: true,
      mutationControls: 0,
    }
  } finally {
    await browser.close()
  }
}

function validateStrict(
  document: Record<string, unknown>,
  baseline: Baseline,
): NonNullable<PackedInstallReport['strict']> {
  const candidate = document as unknown as NonNullable<PackedInstallReport['strict']>
    & { readonly schemaVersion?: unknown; readonly status?: unknown }
  if (
    candidate.schemaVersion !== 1
    || candidate.status !== 'pass'
    || candidate.mode !== 'strict'
    || candidate.enforced !== true
    || candidate.acceptedActivations !== 6
    || candidate.attemptedActivations !== 7
    || candidate.providerStarts !== 6
    || candidate.deniedCode !== 'GLOBAL_ACTIVE_LIMIT'
    || candidate.sourceCommit !== baseline.source.commit
    || candidate.sourcePackageVersion !== baseline.source.packageVersion
    || candidate.activeByRootBeforeDenial?.['packed-root-a'] !== 3
    || candidate.activeByRootBeforeDenial?.['packed-root-b'] !== 3
  ) {
    fail('patched exact-target Strict evidence is incomplete')
  }
  return {
    mode: candidate.mode,
    enforced: candidate.enforced,
    acceptedActivations: candidate.acceptedActivations,
    attemptedActivations: candidate.attemptedActivations,
    providerStarts: candidate.providerStarts,
    deniedCode: candidate.deniedCode,
    activeByRootBeforeDenial: Object.freeze({ ...candidate.activeByRootBeforeDenial }),
    sourceCommit: candidate.sourceCommit,
    sourcePackageVersion: candidate.sourcePackageVersion,
  }
}

function runStrictProof(
  commands: PackedCommandReport[],
  workspaceRoot: string,
  pnpm: string,
  tarballPath: string,
  evidenceDir: string,
): NonNullable<PackedInstallReport['strict']> {
  const baseline = parseBaseline(workspaceRoot)
  const checkout = ensureExactCheckout(commands, workspaceRoot, baseline)
  const patchPath = resolve(workspaceRoot, 'patches/dsh-subagent-admission-seam.patch')
  checked(commands, 'strict-patch-preflight', 'git', ['apply', '--check', patchPath], checkout)

  let disposable = mkdtempSync(join(tmpdir(), STRICT_TEMP_PREFIX))
  assertTemporaryRoot(disposable, STRICT_TEMP_PREFIX)
  rmSync(disposable, { recursive: true })
  try {
    checked(
      commands,
      'strict-worktree-create',
      'git',
      ['worktree', 'add', '--detach', disposable, baseline.source.commit],
      checkout,
    )
    checked(commands, 'strict-patch-apply', 'git', ['apply', patchPath], disposable)
    checked(
      commands,
      'strict-install',
      pnpm,
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      disposable,
    )
    checked(commands, 'strict-host-build', pnpm, ['build:lib:host'], disposable)
    checked(
      commands,
      'strict-packed-add',
      pnpm,
      [
        'add',
        '-Dw',
        '--ignore-scripts',
        '--config.auto-install-peers=false',
        tarballPath,
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
    )

    const destination = resolve(
      disposable,
      'packages/subagent/subagent/tests/admission-conformance/packed-strict.e2e.ts',
    )
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(
      resolve(workspaceRoot, 'tests/conformance/packed-strict.e2e.ts'),
      destination,
    )
    checked(
      commands,
      'strict-fixture-typecheck',
      pnpm,
      ['exec', 'tsc', '-b', 'tsconfig.host.json', '--pretty', 'false'],
      disposable,
    )
    checked(
      commands,
      'strict-focused-proof',
      pnpm,
      [
        'exec',
        'vitest',
        'run',
        'packages/subagent/subagent/tests/admission-conformance/packed-strict.e2e.ts',
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
      {
        DSH_ADMISSION_EVIDENCE_DIR: evidenceDir,
        DSH_ADMISSION_PATCHED_CHECKOUT: '1',
        DSH_ADMISSION_SOURCE_COMMIT: baseline.source.commit,
      },
    )
    return validateStrict(
      readJson(resolve(evidenceDir, 'packed-strict.json')),
      baseline,
    )
  } finally {
    if (disposable.length > 0) {
      assertTemporaryRoot(disposable, STRICT_TEMP_PREFIX)
      command(
        commands,
        'strict-worktree-remove',
        'git',
        ['worktree', 'remove', '--force', disposable],
        checkout,
      )
      rmSync(disposable, { recursive: true, force: true })
      disposable = ''
    }
  }
}

/** Execute the packed-install acceptance flow without touching the user's DSH profile. */
export async function runPackedInstall(
  options: PackedInstallOptions = {},
): Promise<PackedInstallReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT)
  const cleanup = options.cleanup ?? true
  const auditOnly = options.auditOnly ?? false
  const capture = options.captureGui ?? false
  const pnpm = process.env.DSH_PNPM_BIN ?? 'pnpm'
  const commands: PackedCommandReport[] = []
  const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
  assertTemporaryRoot(temporaryRoot, TEMP_PREFIX)
  const dshHome = resolve(temporaryRoot, 'home')
  const evidenceDir = resolve(temporaryRoot, 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  let web: WebProcess | undefined

  try {
    checked(commands, 'pack-plugin', pnpm, ['pack:plugin'], workspaceRoot)
    const tarballPath = pluginTarballPath(workspaceRoot)
    if (!existsSync(tarballPath) || !isAbsolute(tarballPath)) {
      fail(`packed plugin missing at absolute path ${tarballPath}`)
    }
    const tarballSha256 = sha256(readFileSync(tarballPath))
    const clientBundleSha256 = packedClientHash(tarballPath)

    const installArgs = [
      'exec',
      'dsh',
      'plugin',
      '--profile',
      'web',
      'add',
      tarballPath,
    ]
    checked(
      commands,
      'profile-install',
      pnpm,
      installArgs,
      workspaceRoot,
      { DSH_HOME: dshHome, npm_config_offline: 'true' },
    )
    const dump = checked(
      commands,
      'profile-dump',
      pnpm,
      ['exec', 'dsh', '--profile', 'web', '--dump-config'],
      workspaceRoot,
      { DSH_HOME: dshHome },
    ).stdout
    if (!dump.includes('# == dsh-subagent-admission') || !dump.includes('id: subagent-admission')) {
      fail('installed profile dump omitted the admission bundle row')
    }

    const seed = writeAuditSeed(temporaryRoot, workspaceRoot)
    web = await startWeb(pnpm, workspaceRoot, dshHome, seed.overlayPath)
    const audit = validateAudit(await waitForJson(seed.evidencePath))
    const response = await fetch(web.serverUrl)
    if (!response.ok) fail(`Web root returned HTTP ${response.status}`)
    const pluginIds = parseClientBoot(await response.text())
    if (!pluginIds.includes('dsh-subagent-admission')) {
      fail('actual Web client roster omitted dsh-subagent-admission')
    }
    const serverUrl = web.serverUrl

    const gui = capture
      ? await captureGui(
          web.serverUrl,
          options.screenshotPath
            ?? resolve(workspaceRoot, 'evidence/admission-control.png'),
        )
      : undefined
    const strict = auditOnly
      ? undefined
      : runStrictProof(
          commands,
          workspaceRoot,
          pnpm,
          tarballPath,
          evidenceDir,
        )

    await stopChild(web.child)
    recordCommand(
      commands,
      'web-boot',
      pnpm,
      [
        'exec', 'dsh', '--profile', 'web', '--patch', seed.overlayPath,
        '--host', '127.0.0.1', '--port', '0',
      ],
      workspaceRoot,
      { stdout: web.stdout(), stderr: web.stderr(), exitCode: 0 },
    )
    web = undefined

    const report: PackedInstallReport = {
      schemaVersion: 1,
      status: 'pass',
      temporaryRoot,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        dshPackageVersion: packageVersion(workspaceRoot, '@deepseek-ai/dsh'),
        stockSubagentPackageVersion: packageVersion(
          workspaceRoot,
          '@deepseek-ai/dsh-subagent',
        ),
      },
      package: { tarballPath, tarballSha256, clientBundleSha256 },
      profile: { dump, dumpSha256: sha256(dump) },
      audit: {
        snapshot: audit.snapshot,
        concurrentChildrenAccepted: audit.concurrentChildrenAccepted,
      },
      clientBoot: { serverUrl, pluginIds },
      ...(strict === undefined ? {} : { strict }),
      ...(gui === undefined ? {} : { gui }),
      commands: Object.freeze(commands),
    }
    return report
  } finally {
    if (web !== undefined) await stopChild(web.child)
    if (cleanup) {
      assertTemporaryRoot(temporaryRoot, TEMP_PREFIX)
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }
}

interface CliOptions {
  readonly run: PackedInstallOptions
  readonly outputPath?: string
}

function parseCli(argv: readonly string[]): CliOptions {
  let auditOnly = false
  let capture = false
  let cleanup = true
  let screenshotPath: string | undefined
  let outputPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--audit-only') auditOnly = true
    else if (arg === '--capture-gui') capture = true
    else if (arg === '--keep-temp') cleanup = false
    else if (arg === '--screenshot') {
      screenshotPath = argv[++index]
      if (screenshotPath === undefined) fail('--screenshot needs a path')
    } else if (arg === '--output') {
      outputPath = argv[++index]
      if (outputPath === undefined) fail('--output needs a path')
    } else {
      fail(`unknown argument ${arg}`)
    }
  }
  return {
    run: {
      auditOnly,
      captureGui: capture,
      cleanup,
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    },
    ...(outputPath === undefined ? {} : { outputPath }),
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2))
    const report = await runPackedInstall(options.run)
    const rendered = `${JSON.stringify(report, null, 2)}\n`
    if (options.outputPath !== undefined) {
      const outputPath = resolve(options.outputPath)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, rendered)
    }
    process.stdout.write(rendered)
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}
