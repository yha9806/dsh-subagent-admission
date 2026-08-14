#!/usr/bin/env tsx
/** Collect and validate one source-fingerprint-bound local release evidence set. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_RESULT_IDS } from '../tests/conformance/matrix.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const EVIDENCE_ROOT = resolve(ROOT, 'evidence')
const MANIFEST_PATH = resolve(EVIDENCE_ROOT, 'manifest.json')
const PROMOTED_SCREENSHOT = resolve(ROOT, 'docs/assets/admission-control.png')
const PNPM = process.env.DSH_PNPM_BIN ?? 'pnpm'
const MAX_BUFFER = 128 * 1024 * 1024

const REPORTS = Object.freeze([
  Object.freeze({ id: 'conformance', path: 'evidence/conformance.json' }),
  Object.freeze({ id: 'crash-json', path: 'evidence/crash-json.json' }),
  Object.freeze({ id: 'crash-sqlite', path: 'evidence/crash-sqlite.json' }),
  Object.freeze({ id: 'packed-install', path: 'evidence/packed-install.json' }),
  Object.freeze({ id: 'benchmark', path: 'evidence/benchmark.json' }),
  Object.freeze({ id: 'reproduction-strict', path: 'evidence/reproduction-strict.json' }),
  Object.freeze({ id: 'gui-candidate', path: 'evidence/admission-control.png' }),
])

interface Baseline {
  readonly schemaVersion: 1
  readonly status: 'aligned' | 'source-npm-diverged'
  readonly source: {
    readonly repository: string
    readonly commit: string
    readonly packageVersion: string
  }
  readonly npm: Readonly<Record<string, { readonly latest: string; readonly next: string }>>
  readonly discussion131: {
    readonly url: string
    readonly state: string
    readonly commentCount: number
    readonly maintainerCommentCount: number
  }
  readonly strictTargets: readonly {
    readonly sourceCommit: string
    readonly sourcePackageVersion: string
    readonly protocolVersion: number
    readonly patchSha256: string
    readonly verificationCommand: string
  }[]
  readonly strictTargetsCurrent: boolean
}

interface PackageManifest {
  readonly name: string
  readonly version: string
}

interface CommandRecord {
  readonly name: string
  readonly command: string
}

interface ArtifactRecord {
  readonly id: string
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

interface SourceFingerprint {
  readonly sha256: string
  readonly files: number
}

interface ReleaseManifest {
  readonly schemaVersion: 1
  readonly status: 'pass'
  readonly generatedAt: string
  readonly source: {
    readonly fingerprintSha256: string
    readonly fileCount: number
    readonly gitHeadAtCollection: string
    readonly branchAtCollection: string
  }
  readonly identities: {
    readonly pluginName: string
    readonly pluginVersion: string
    readonly officialRepository: string
    readonly sourceCommit: string
    readonly sourcePackageVersion: string
    readonly npmDshVersion: string
    readonly npmSubagentVersion: string
    readonly baselineStatus: string
    readonly discussion131State: string
    readonly discussion131Comments: number
    readonly discussion131MaintainerComments: number
    readonly protocolVersion: 1
    readonly patchSha256: string
    readonly packageTarballSha256: string
    readonly clientBundleSha256: string
  }
  readonly environment: {
    readonly node: string
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly pnpm: string
  }
  readonly artifacts: readonly ArtifactRecord[]
  readonly promotedScreenshot: {
    readonly path: 'docs/assets/admission-control.png'
    readonly sha256: string
    readonly width: 1440
    readonly height: 900
    readonly evidenceClass: 'automated-local-native-gui'
    readonly humanReviewed: false
  }
  readonly commands: readonly CommandRecord[]
  readonly boundaries: {
    readonly modelCalls: 0
    readonly apiKeysRequired: false
    readonly ciExecuted: false
    readonly productionDeployment: false
    readonly officialAdoption: false
    readonly publication: false
  }
}

interface CliOptions {
  readonly mode: 'collect' | 'check'
  readonly promoteScreenshot: boolean
}

const COLLECT_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'sync package documents',
    args: Object.freeze(['docs:sync']),
  }),
  Object.freeze({
    name: 'exact-target and stock conformance',
    args: Object.freeze([
      'exec', 'tsx', 'scripts/run-strict-conformance.mts',
      '--output', 'evidence/conformance.json',
    ]),
  }),
  Object.freeze({
    name: 'JSON crash recovery',
    args: Object.freeze([
      'exec', 'tsx', 'scripts/crash-fixture.mts',
      '--backend', 'json', '--output', 'evidence/crash-json.json',
    ]),
  }),
  Object.freeze({
    name: 'SQLite crash recovery',
    args: Object.freeze([
      'exec', 'tsx', 'scripts/crash-fixture.mts',
      '--backend', 'sqlite', '--output', 'evidence/crash-sqlite.json',
    ]),
  }),
  Object.freeze({
    name: 'packed Audit Strict and GUI',
    args: Object.freeze([
      'exec', 'tsx', 'scripts/packed-install.mts',
      '--capture-gui',
      '--screenshot', 'evidence/admission-control.png',
      '--output', 'evidence/packed-install.json',
    ]),
  }),
  Object.freeze({
    name: 'admission benchmark',
    args: Object.freeze([
      'benchmark', '--',
      '--iterations', '100',
      '--warmup', '10',
      '--output', 'evidence/benchmark.json',
    ]),
  }),
  Object.freeze({
    name: 'Discussion 131 Strict reproduction',
    args: Object.freeze([
      'reproduce:131', '--',
      '--strict-only',
      '--children', '56',
      '--output', 'evidence/reproduction-strict.json',
    ]),
  }),
])

function fail(message: string): never {
  throw new Error(`release evidence: ${message}`)
}

function parseCli(argv: readonly string[]): CliOptions {
  let mode: CliOptions['mode'] | undefined
  let promoteScreenshot = false
  for (const argument of argv) {
    if (argument === '--collect' && mode === undefined) mode = 'collect'
    else if (argument === '--check' && mode === undefined) mode = 'check'
    else if (argument === '--promote-screenshot' && !promoteScreenshot) {
      promoteScreenshot = true
    } else fail('usage: release-evidence.mts (--collect | --check) [--promote-screenshot]')
  }
  if (mode === undefined || (mode === 'check' && promoteScreenshot)) {
    fail('usage: release-evidence.mts (--collect | --check) [--promote-screenshot]')
  }
  return { mode, promoteScreenshot }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) fail(`missing ${relative(ROOT, path)}`)
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return record(value, relative(ROOT, path))
  } catch (error) {
    fail(`${relative(ROOT, path)} is not valid JSON: ${String(error)}`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a string`)
  return value
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail(`${label} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function relativeArtifactPath(path: string): string {
  const absolute = resolve(path)
  const fromRoot = relative(ROOT, absolute)
  if (
    fromRoot.length === 0
    || isAbsolute(fromRoot)
    || fromRoot.startsWith('..')
    || fromRoot.includes('..' + '/')
  ) fail(`unsafe repository path ${path}`)
  return fromRoot.split('\\').join('/')
}

function safeRegularFile(path: string, expectedBase: string): void {
  const absolute = resolve(path)
  const base = resolve(expectedBase)
  const fromBase = relative(base, absolute)
  if (
    fromBase.length === 0
    || isAbsolute(fromBase)
    || fromBase.startsWith('..')
    || !existsSync(absolute)
  ) fail(`unsafe or missing file ${path}`)
  const status = lstatSync(absolute)
  if (!status.isFile() || status.isSymbolicLink()) fail(`${path} must be a regular non-symlink file`)
}

function safeDirectory(path: string, expectedParent: string): void {
  const absolute = resolve(path)
  const parent = resolve(expectedParent)
  const fromParent = relative(parent, absolute)
  if (
    fromParent.length === 0
    || isAbsolute(fromParent)
    || fromParent.startsWith('..')
    || !existsSync(absolute)
  ) fail(`unsafe or missing directory ${path}`)
  const status = lstatSync(absolute)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail(`${path} must be a real directory, not a symlink`)
  }
}

function safeWritableFileTarget(path: string, expectedBase: string): void {
  const absolute = resolve(path)
  const base = resolve(expectedBase)
  const fromBase = relative(base, absolute)
  if (
    fromBase.length === 0
    || isAbsolute(fromBase)
    || fromBase.startsWith('..')
  ) fail(`unsafe writable target ${path}`)
  if (!existsSync(absolute)) return
  const status = lstatSync(absolute)
  if (!status.isFile() || status.isSymbolicLink()) {
    fail(`${path} must be a regular non-symlink file before replacement`)
  }
}

function renderCommand(args: readonly string[]): string {
  return [PNPM, ...args].join(' ')
}

function command(
  records: CommandRecord[],
  name: string,
  args: readonly string[],
): void {
  const rendered = renderCommand(args)
  const result = spawnSync(PNPM, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: MAX_BUFFER,
  })
  if ((result.stdout ?? '').length > 0) process.stdout.write(result.stdout ?? '')
  if ((result.stderr ?? '').length > 0) process.stderr.write(result.stderr ?? '')
  if (result.error !== undefined) fail(`${name} could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`${name} failed with exit code ${String(result.status)}`)
  records.push(Object.freeze({ name, command: rendered }))
}

function quiet(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${executable} ${args.join(' ')} failed`)
  }
  return (result.stdout ?? '').trim()
}

function parseBaseline(): Baseline {
  const value = JSON.parse(readFileSync(resolve(ROOT, 'compatibility/baseline.json'), 'utf8')) as Baseline
  if (
    value.schemaVersion !== 1
    || !/^[0-9a-f]{40}$/.test(value.source?.commit ?? '')
    || !Array.isArray(value.strictTargets)
    || value.strictTargets.length !== 1
    || value.strictTargetsCurrent !== true
  ) fail('compatibility baseline has no single current Strict target')
  const [target] = value.strictTargets
  if (
    target?.sourceCommit !== value.source.commit
    || target.sourcePackageVersion !== value.source.packageVersion
    || target.protocolVersion !== 1
    || !/^[0-9a-f]{64}$/.test(target.patchSha256)
  ) fail('Strict target does not match the official source identity')
  return value
}

function parsePackage(): PackageManifest {
  const value = JSON.parse(readFileSync(
    resolve(ROOT, 'packages/dsh-subagent-admission/package.json'),
    'utf8',
  )) as PackageManifest
  if (value.name !== 'dsh-subagent-admission' || value.version !== '0.1.0-rc.1') {
    fail('unexpected plugin package identity')
  }
  return value
}

function currentPatchHash(): string {
  return sha256(readFileSync(resolve(ROOT, 'patches/dsh-subagent-admission-seam.patch')))
}

function sourceFingerprint(): SourceFingerprint {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: MAX_BUFFER },
  )
  if (result.error !== undefined || result.status !== 0) fail('git ls-files failed')
  const paths = (result.stdout ?? Buffer.alloc(0)).toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => path === 'evidence/.gitkeep' || !path.startsWith('evidence/'))
    .sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    if (isAbsolute(path) || path.startsWith('..')) fail(`unsafe source path ${path}`)
    const absolute = resolve(ROOT, path)
    const status = lstatSync(absolute)
    if (!status.isFile() || status.isSymbolicLink()) fail(`source fingerprint rejects ${path}`)
    const content = readFileSync(absolute)
    hash.update(String(Buffer.byteLength(path)))
    hash.update(':')
    hash.update(path)
    hash.update(':')
    hash.update(String(content.length))
    hash.update(':')
    hash.update(content)
    hash.update('\0')
  }
  return Object.freeze({ sha256: hash.digest('hex'), files: paths.length })
}

function pngDimensions(path: string): { width: number; height: number } {
  const value = readFileSync(path)
  if (
    value.length < 24
    || value.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || value.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) fail(`${relativeArtifactPath(path)} is not a valid PNG header`)
  return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) }
}

function validateConformance(value: Record<string, unknown>, baseline: Baseline): void {
  expectEqual(value.schemaVersion, 1, 'conformance schemaVersion')
  expectEqual(value.status, 'pass', 'conformance status')
  expectEqual(value.sourceCommit, baseline.source.commit, 'conformance source commit')
  expectEqual(value.sourcePackageVersion, baseline.source.packageVersion, 'conformance source version')
  expectEqual(value.stockPackageVersion, baseline.npm['@deepseek-ai/dsh']?.next, 'conformance stock version')
  expectEqual(value.strictResults, REQUIRED_RESULT_IDS.length, 'conformance Strict result count')
  expectEqual(value.stockAudit, 'pass-non-enforcing', 'conformance stock Audit')
}

function validateCrash(value: Record<string, unknown>, backend: 'json' | 'sqlite'): void {
  expectEqual(value.schemaVersion, 1, `${backend} crash schemaVersion`)
  expectEqual(value.status, 'pass', `${backend} crash status`)
  expectEqual(value.backend, backend, `${backend} crash backend`)
  expectEqual(value.rootAdmittedTotal, 1, `${backend} cumulative total`)
  expectEqual(value.rootRevision, 1, `${backend} cumulative revision`)
  expectEqual(value.globalActive, 0, `${backend} reset active count`)
  expectEqual(array(value.activeLeases, `${backend} active leases`).length, 0, `${backend} active leases`)
  expectEqual(value.nextAdmissionCode, 'ROOT_TOTAL_LIMIT', `${backend} next denial`)
  expectEqual(value.crashMarker, 'LEDGER_COMMITTED', `${backend} crash marker`)
  expectEqual(value.crashSignal, 'SIGKILL', `${backend} crash signal`)
  expectEqual(value.exactChildProcess, true, `${backend} exact child`)
}

function validatePacked(
  value: Record<string, unknown>,
  baseline: Baseline,
): { tarballSha256: string; clientBundleSha256: string; screenshotSha256: string } {
  expectEqual(value.schemaVersion, 1, 'packed schemaVersion')
  expectEqual(value.status, 'pass', 'packed status')
  const environment = record(value.environment, 'packed environment')
  expectEqual(environment.dshPackageVersion, baseline.npm['@deepseek-ai/dsh']?.next, 'packed DSH version')
  expectEqual(environment.stockSubagentPackageVersion, baseline.npm['@deepseek-ai/dsh-subagent']?.next, 'packed stock subagent')
  const audit = record(value.audit, 'packed Audit')
  expectEqual(audit.concurrentChildrenAccepted, 7, 'packed Audit accepted')
  const snapshot = record(audit.snapshot, 'packed Audit snapshot')
  expectEqual(snapshot.mode, 'audit', 'packed Audit mode')
  expectEqual(snapshot.enforced, false, 'packed Audit enforcement')
  const strict = record(value.strict, 'packed Strict')
  expectEqual(strict.mode, 'strict', 'packed Strict mode')
  expectEqual(strict.enforced, true, 'packed Strict enforcement')
  expectEqual(strict.providerStarts, 6, 'packed Strict provider starts')
  expectEqual(strict.deniedCode, 'GLOBAL_ACTIVE_LIMIT', 'packed Strict denial')
  expectEqual(strict.sourceCommit, baseline.source.commit, 'packed Strict source commit')
  expectEqual(strict.sourcePackageVersion, baseline.source.packageVersion, 'packed Strict source version')
  const gui = record(value.gui, 'packed GUI')
  expectEqual(record(gui.viewport, 'packed GUI viewport').width, 1440, 'packed GUI width')
  expectEqual(record(gui.viewport, 'packed GUI viewport').height, 900, 'packed GUI height')
  expectEqual(gui.quotaCards, 4, 'packed GUI quota cards')
  expectEqual(gui.activeTab, true, 'packed GUI active tab')
  expectEqual(gui.nativeTabsPresent, true, 'packed GUI native tabs')
  expectEqual(gui.mutationControls, 0, 'packed GUI mutation controls')
  for (const row of array(value.commands, 'packed commands')) {
    expectEqual(record(row, 'packed command').exitCode, 0, 'packed command exit')
  }
  const packageEvidence = record(value.package, 'packed package')
  return {
    tarballSha256: string(packageEvidence.tarballSha256, 'packed tarball hash'),
    clientBundleSha256: string(packageEvidence.clientBundleSha256, 'packed client hash'),
    screenshotSha256: string(gui.screenshotSha256, 'packed screenshot hash'),
  }
}

function validateBenchmark(value: Record<string, unknown>, packageManifest: PackageManifest): void {
  expectEqual(value.schemaVersion, 1, 'benchmark schemaVersion')
  expectEqual(value.status, 'measured', 'benchmark status')
  const parameters = record(value.parameters, 'benchmark parameters')
  expectEqual(parameters.iterations, 100, 'benchmark iterations')
  expectEqual(parameters.warmup, 10, 'benchmark warmup')
  expectEqual(parameters.contention, 64, 'benchmark contention')
  const environment = record(value.environment, 'benchmark environment')
  expectEqual(environment.pluginVersion, packageManifest.version, 'benchmark plugin version')
  expectEqual(environment.dshPackageVersion, '0.1.0-rc.6', 'benchmark DSH version')
  const cases = record(value.cases, 'benchmark cases')
  if (Object.keys(cases).length < 6) fail('benchmark omitted measured cases')
  for (const [name, measured] of Object.entries(cases)) {
    const samples = array(record(measured, `benchmark case ${name}`).samples, `benchmark ${name} samples`)
    expectEqual(samples.length, 100, `benchmark ${name} sample count`)
    if (!samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample))) {
      fail(`benchmark ${name} contains a non-numeric sample`)
    }
  }
}

function validateReproduction(value: Record<string, unknown>, baseline: Baseline): void {
  expectEqual(value.schemaVersion, 1, 'reproduction schemaVersion')
  expectEqual(value.status, 'measured', 'reproduction status')
  expectEqual(value.discussion, baseline.discussion131.url, 'reproduction discussion')
  const shape = record(value.shape, 'reproduction shape')
  expectEqual(shape.requestedChildren, 56, 'reproduction child count')
  expectEqual(shape.topology, 'binary-nested', 'reproduction topology')
  expectEqual(shape.externalModelCalls, 0, 'reproduction model calls')
  expectEqual(shape.apiKeysRequired, false, 'reproduction API key requirement')
  const safety = record(value.safety, 'reproduction safety')
  expectEqual(safety.stockStressAuthorized, false, 'reproduction stock authorisation')
  expectEqual(safety.stockStressExecuted, false, 'reproduction stock execution')
  expectEqual(safety.externalNetworkRequests, 0, 'reproduction network requests')
  if ('stock' in value) fail('release reproduction must be Strict-only')
  const strict = record(value.strict, 'reproduction Strict')
  expectEqual(strict.enforced, true, 'reproduction enforcement')
  expectEqual(strict.providerStarts, 4, 'reproduction provider starts')
  expectEqual(strict.peakRootActive, 4, 'reproduction root active peak')
  expectEqual(record(strict.deniedByCode, 'reproduction denials').ROOT_ACTIVE_LIMIT, 5, 'root denials')
  const globalProbe = record(strict.globalProbe, 'reproduction global probe')
  expectEqual(globalProbe.providerStarts, 6, 'global probe starts')
  expectEqual(globalProbe.deniedCode, 'GLOBAL_ACTIVE_LIMIT', 'global probe denial')
}

function expectedTarball(packageManifest: PackageManifest): string {
  return resolve(ROOT, 'dist', `${packageManifest.name}-${packageManifest.version}.tgz`)
}

function validateTarball(
  packageManifest: PackageManifest,
  expectedTarballHash: string,
  expectedClientHash: string,
): void {
  const path = expectedTarball(packageManifest)
  safeRegularFile(path, resolve(ROOT, 'dist'))
  expectEqual(sha256(readFileSync(path)), expectedTarballHash, 'current tarball hash')
  const result = spawnSync(
    'tar',
    ['-xOf', path, 'package/lib/client.js'],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: MAX_BUFFER },
  )
  if (result.error !== undefined || result.status !== 0) fail('could not extract packed client bundle')
  expectEqual(sha256(result.stdout ?? Buffer.alloc(0)), expectedClientHash, 'packed client bundle hash')
}

function artifactRecords(): readonly ArtifactRecord[] {
  return Object.freeze(REPORTS.map((item) => {
    const absolute = resolve(ROOT, item.path)
    safeRegularFile(absolute, EVIDENCE_ROOT)
    const contents = readFileSync(absolute)
    return Object.freeze({
      id: item.id,
      path: item.path,
      bytes: contents.length,
      sha256: sha256(contents),
    })
  }))
}

function validateEvidenceSet(
  baseline: Baseline,
  packageManifest: PackageManifest,
): { tarballSha256: string; clientBundleSha256: string; screenshotSha256: string } {
  const conformance = readJson(resolve(ROOT, 'evidence/conformance.json'))
  const crashJson = readJson(resolve(ROOT, 'evidence/crash-json.json'))
  const crashSqlite = readJson(resolve(ROOT, 'evidence/crash-sqlite.json'))
  const packed = readJson(resolve(ROOT, 'evidence/packed-install.json'))
  const benchmark = readJson(resolve(ROOT, 'evidence/benchmark.json'))
  const reproduction = readJson(resolve(ROOT, 'evidence/reproduction-strict.json'))
  validateConformance(conformance, baseline)
  validateCrash(crashJson, 'json')
  validateCrash(crashSqlite, 'sqlite')
  const packedHashes = validatePacked(packed, baseline)
  validateBenchmark(benchmark, packageManifest)
  validateReproduction(reproduction, baseline)

  const screenshotPath = resolve(ROOT, 'evidence/admission-control.png')
  safeRegularFile(screenshotPath, EVIDENCE_ROOT)
  expectEqual(pngDimensions(screenshotPath).width, 1440, 'candidate screenshot width')
  expectEqual(pngDimensions(screenshotPath).height, 900, 'candidate screenshot height')
  expectEqual(sha256(readFileSync(screenshotPath)), packedHashes.screenshotSha256, 'candidate screenshot hash')
  validateTarball(packageManifest, packedHashes.tarballSha256, packedHashes.clientBundleSha256)
  return packedHashes
}

function assertDisposableTemp(path: string, prefixes: readonly string[]): void {
  const absolute = resolve(path)
  const base = resolve(tmpdir())
  const fromBase = relative(base, absolute)
  if (
    fromBase.length === 0
    || isAbsolute(fromBase)
    || fromBase.startsWith('..')
    || !prefixes.some((prefix) => basename(absolute).startsWith(prefix))
  ) fail(`refusing to clean unowned temporary path ${path}`)
}

function cleanReportedTemporaryRoot(reportPath: string, prefixes: readonly string[]): void {
  const report = readJson(reportPath)
  const candidate = report.evidenceDir
  if (typeof candidate !== 'string' || candidate.length === 0 || !existsSync(candidate)) return
  assertDisposableTemp(candidate, prefixes)
  rmSync(candidate, { recursive: true, force: true })
}

function removeOldEvidence(): void {
  safeDirectory(EVIDENCE_ROOT, ROOT)
  for (const item of REPORTS) {
    const path = resolve(ROOT, item.path)
    const fromEvidence = relative(EVIDENCE_ROOT, path)
    if (isAbsolute(fromEvidence) || fromEvidence.startsWith('..')) fail(`unsafe evidence target ${item.path}`)
    rmSync(path, { force: true })
  }
  rmSync(MANIFEST_PATH, { force: true })
}

function collect(promoteScreenshot: boolean): ReleaseManifest {
  removeOldEvidence()
  const records: CommandRecord[] = []
  for (const spec of COLLECT_COMMANDS) command(records, spec.name, spec.args)

  const baseline = parseBaseline()
  const packageManifest = parsePackage()
  const patchHash = currentPatchHash()
  const target = baseline.strictTargets[0]!
  expectEqual(patchHash, target.patchSha256, 'current reference patch hash')
  const packedHashes = validateEvidenceSet(baseline, packageManifest)

  if (promoteScreenshot) {
    const docsRoot = resolve(ROOT, 'docs')
    const assetsRoot = resolve(docsRoot, 'assets')
    safeDirectory(docsRoot, ROOT)
    safeDirectory(assetsRoot, docsRoot)
    safeWritableFileTarget(PROMOTED_SCREENSHOT, assetsRoot)
    copyFileSync(resolve(EVIDENCE_ROOT, 'admission-control.png'), PROMOTED_SCREENSHOT)
  }
  safeRegularFile(PROMOTED_SCREENSHOT, resolve(ROOT, 'docs/assets'))
  const promotedDimensions = pngDimensions(PROMOTED_SCREENSHOT)
  expectEqual(promotedDimensions.width, 1440, 'promoted screenshot width')
  expectEqual(promotedDimensions.height, 900, 'promoted screenshot height')
  const promotedHash = sha256(readFileSync(PROMOTED_SCREENSHOT))
  expectEqual(promotedHash, packedHashes.screenshotSha256, 'promoted screenshot hash')

  const fingerprint = sourceFingerprint()
  const manifest: ReleaseManifest = Object.freeze({
    schemaVersion: 1,
    status: 'pass',
    generatedAt: new Date().toISOString(),
    source: Object.freeze({
      fingerprintSha256: fingerprint.sha256,
      fileCount: fingerprint.files,
      gitHeadAtCollection: quiet('git', ['rev-parse', 'HEAD']),
      branchAtCollection: quiet('git', ['branch', '--show-current']),
    }),
    identities: Object.freeze({
      pluginName: packageManifest.name,
      pluginVersion: packageManifest.version,
      officialRepository: baseline.source.repository,
      sourceCommit: baseline.source.commit,
      sourcePackageVersion: baseline.source.packageVersion,
      npmDshVersion: baseline.npm['@deepseek-ai/dsh']!.next,
      npmSubagentVersion: baseline.npm['@deepseek-ai/dsh-subagent']!.next,
      baselineStatus: baseline.status,
      discussion131State: baseline.discussion131.state,
      discussion131Comments: baseline.discussion131.commentCount,
      discussion131MaintainerComments: baseline.discussion131.maintainerCommentCount,
      protocolVersion: 1,
      patchSha256: patchHash,
      packageTarballSha256: packedHashes.tarballSha256,
      clientBundleSha256: packedHashes.clientBundleSha256,
    }),
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pnpm: quiet(PNPM, ['--version']),
    }),
    artifacts: artifactRecords(),
    promotedScreenshot: Object.freeze({
      path: 'docs/assets/admission-control.png',
      sha256: promotedHash,
      width: 1440,
      height: 900,
      evidenceClass: 'automated-local-native-gui',
      humanReviewed: false,
    }),
    commands: Object.freeze(records),
    boundaries: Object.freeze({
      modelCalls: 0,
      apiKeysRequired: false,
      ciExecuted: false,
      productionDeployment: false,
      officialAdoption: false,
      publication: false,
    }),
  })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  cleanReportedTemporaryRoot(
    resolve(EVIDENCE_ROOT, 'conformance.json'),
    ['dsh-strict-conformance-evidence-'],
  )
  cleanReportedTemporaryRoot(
    resolve(EVIDENCE_ROOT, 'crash-json.json'),
    ['dsh-crash-json-'],
  )
  cleanReportedTemporaryRoot(
    resolve(EVIDENCE_ROOT, 'crash-sqlite.json'),
    ['dsh-crash-sqlite-'],
  )
  return manifest
}

function validateManifest(): ReleaseManifest {
  const baseline = parseBaseline()
  const packageManifest = parsePackage()
  const value = readJson(MANIFEST_PATH) as unknown as ReleaseManifest
  expectEqual(value.schemaVersion, 1, 'manifest schemaVersion')
  expectEqual(value.status, 'pass', 'manifest status')
  const generatedAt = string(value.generatedAt, 'manifest generatedAt')
  if (Number.isNaN(Date.parse(generatedAt))) fail('manifest generatedAt must be an ISO timestamp')
  const source = record(value.source, 'manifest source')
  const identities = record(value.identities, 'manifest identities')
  const environment = record(value.environment, 'manifest environment')
  const promotedScreenshot = record(value.promotedScreenshot, 'manifest promoted screenshot')
  const boundaries = record(value.boundaries, 'manifest boundaries')
  const target = baseline.strictTargets[0]!
  expectEqual(identities.pluginName, packageManifest.name, 'manifest plugin name')
  expectEqual(identities.pluginVersion, packageManifest.version, 'manifest plugin version')
  expectEqual(identities.officialRepository, baseline.source.repository, 'manifest official repository')
  expectEqual(identities.sourceCommit, baseline.source.commit, 'manifest source commit')
  expectEqual(identities.sourcePackageVersion, baseline.source.packageVersion, 'manifest source version')
  expectEqual(identities.npmDshVersion, baseline.npm['@deepseek-ai/dsh']?.next, 'manifest npm DSH version')
  expectEqual(identities.npmSubagentVersion, baseline.npm['@deepseek-ai/dsh-subagent']?.next, 'manifest npm subagent version')
  expectEqual(identities.baselineStatus, baseline.status, 'manifest baseline status')
  expectEqual(identities.discussion131State, baseline.discussion131.state, 'manifest Discussion state')
  expectEqual(identities.protocolVersion, 1, 'manifest protocol')
  expectEqual(identities.patchSha256, target.patchSha256, 'manifest patch hash')
  expectEqual(currentPatchHash(), target.patchSha256, 'current patch hash')
  expectEqual(identities.discussion131Comments, baseline.discussion131.commentCount, 'manifest Discussion comments')
  expectEqual(identities.discussion131MaintainerComments, baseline.discussion131.maintainerCommentCount, 'manifest maintainer comments')
  if (!/^[0-9a-f]{40}$/.test(string(source.gitHeadAtCollection, 'manifest collection HEAD'))) {
    fail('manifest collection HEAD must be a full Git commit')
  }
  string(source.branchAtCollection, 'manifest collection branch')
  const fingerprint = sourceFingerprint()
  expectEqual(source.fingerprintSha256, fingerprint.sha256, 'manifest source fingerprint')
  expectEqual(source.fileCount, fingerprint.files, 'manifest source file count')
  string(environment.node, 'manifest Node version')
  string(environment.platform, 'manifest platform')
  string(environment.arch, 'manifest architecture')
  string(environment.pnpm, 'manifest pnpm version')

  const packedHashes = validateEvidenceSet(baseline, packageManifest)
  expectEqual(identities.packageTarballSha256, packedHashes.tarballSha256, 'manifest tarball hash')
  expectEqual(identities.clientBundleSha256, packedHashes.clientBundleSha256, 'manifest client hash')
  const artifacts = array(value.artifacts, 'manifest artifacts') as readonly ArtifactRecord[]
  const expectedArtifacts = artifactRecords()
  expectEqual(artifacts.length, expectedArtifacts.length, 'manifest artifact count')
  for (const expected of expectedArtifacts) {
    const actual = artifacts.find((artifact) => artifact.id === expected.id)
    if (actual === undefined) fail(`manifest omitted artifact ${expected.id}`)
    expectEqual(actual.path, expected.path, `${expected.id} path`)
    expectEqual(actual.bytes, expected.bytes, `${expected.id} bytes`)
    expectEqual(actual.sha256, expected.sha256, `${expected.id} hash`)
  }

  const commands = array(value.commands, 'manifest commands')
  expectEqual(commands.length, COLLECT_COMMANDS.length, 'manifest command count')
  for (const [index, expected] of COLLECT_COMMANDS.entries()) {
    const actual = record(commands[index], `manifest command ${index}`)
    expectEqual(actual.name, expected.name, `manifest command ${index} name`)
    expectEqual(actual.command, renderCommand(expected.args), `manifest command ${index} invocation`)
  }

  safeRegularFile(PROMOTED_SCREENSHOT, resolve(ROOT, 'docs/assets'))
  expectEqual(promotedScreenshot.path, 'docs/assets/admission-control.png', 'manifest promoted path')
  expectEqual(promotedScreenshot.width, 1440, 'manifest promoted width')
  expectEqual(promotedScreenshot.height, 900, 'manifest promoted height')
  expectEqual(promotedScreenshot.evidenceClass, 'automated-local-native-gui', 'manifest screenshot evidence class')
  expectEqual(pngDimensions(PROMOTED_SCREENSHOT).width, 1440, 'current promoted width')
  expectEqual(pngDimensions(PROMOTED_SCREENSHOT).height, 900, 'current promoted height')
  expectEqual(sha256(readFileSync(PROMOTED_SCREENSHOT)), promotedScreenshot.sha256, 'manifest promoted hash')
  expectEqual(promotedScreenshot.sha256, packedHashes.screenshotSha256, 'manifest screenshot provenance')
  expectEqual(promotedScreenshot.humanReviewed, false, 'manifest human review boundary')
  expectEqual(boundaries.modelCalls, 0, 'manifest model-call boundary')
  expectEqual(boundaries.apiKeysRequired, false, 'manifest API-key boundary')
  expectEqual(boundaries.ciExecuted, false, 'manifest CI boundary')
  expectEqual(boundaries.productionDeployment, false, 'manifest deployment boundary')
  expectEqual(boundaries.officialAdoption, false, 'manifest official boundary')
  expectEqual(boundaries.publication, false, 'manifest publication boundary')
  return value
}

const options = parseCli(process.argv.slice(2))
try {
  const manifest = options.mode === 'collect'
    ? collect(options.promoteScreenshot)
    : validateManifest()
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'pass',
    mode: options.mode,
    manifest: relativeArtifactPath(MANIFEST_PATH),
    sourceFingerprintSha256: manifest.source.fingerprintSha256,
    artifacts: manifest.artifacts.length,
    promotedScreenshotSha256: manifest.promotedScreenshot.sha256,
  }, null, 2)}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
