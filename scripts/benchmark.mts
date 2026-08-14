#!/usr/bin/env tsx
/** Reproducible, no-network microbenchmarks for the admission kernel. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AdmissionAuthority,
  type AdmissionAuthorityEvent,
  type AdmissionLedger,
} from '../packages/dsh-subagent-admission/src/host/authority.js'
import { LedgerOperationalError, type ReserveNewInput } from '../packages/dsh-subagent-admission/src/host/ledger.js'
import { ActiveLeaseRegistry } from '../packages/dsh-subagent-admission/src/host/leases.js'
import type {
  ChildBindingInput,
  ResolvedLineage,
  RootResolution,
} from '../packages/dsh-subagent-admission/src/host/root-resolver.js'
import type {
  SubagentAdmissionPermitV1,
  SubagentAdmissionRequestV1,
} from '../packages/dsh-subagent-admission/src/host/seam-v1.js'
import { AdmissionTelemetry } from '../packages/dsh-subagent-admission/src/host/telemetry.js'
import type { AdmissionLimits } from '../packages/dsh-subagent-admission/src/types.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const PACKAGE_MANIFEST = resolve(
  WORKSPACE_ROOT,
  'packages/dsh-subagent-admission/package.json',
)
const CONTENTION = 64 as const

export interface BenchmarkClock {
  now(): bigint
}

export interface BenchmarkSummary {
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

export interface BenchmarkCase {
  readonly unit: 'nanoseconds'
  readonly boundary: string
  readonly samples: readonly number[]
  readonly summary: BenchmarkSummary
}

export interface BenchmarkReport {
  readonly schemaVersion: 1
  readonly status: 'measured'
  readonly generatedAt: string
  readonly environment: {
    readonly node: string
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly cpuModel: string
    readonly cpuCount: number
    readonly pluginVersion: string
    readonly dshPackageVersion: string
    readonly storage: 'in-memory-instrumented'
    readonly measurementClock: 'process.hrtime.bigint' | 'injected-monotonic-bigint'
  }
  readonly parameters: {
    readonly iterations: number
    readonly warmup: number
    readonly contention: typeof CONTENTION
  }
  readonly cases: {
    readonly denied: BenchmarkCase
    readonly acceptedNew: BenchmarkCase
    readonly coldResume: BenchmarkCase
    readonly releaseAfterCleanup: BenchmarkCase
    readonly snapshotGet: BenchmarkCase
    readonly snapshotWatch: BenchmarkCase
    readonly concurrentReserve64: BenchmarkCase
  }
  readonly operationBudgets: {
    readonly denied: {
      readonly accepted: 0
      readonly denied: number
      readonly ledgerWrites: 0
    }
    readonly acceptedNew: {
      readonly accepted: number
      readonly denied: 0
      readonly ledgerWrites: number
    }
    readonly coldResume: {
      readonly accepted: number
      readonly denied: 0
      readonly ledgerWrites: 0
    }
    readonly releaseAfterCleanup: {
      readonly releases: number
      readonly ledgerWrites: 0
    }
    readonly snapshotGet: { readonly ledgerWrites: 0 }
    readonly snapshotWatch: { readonly ledgerWrites: 0 }
    readonly concurrentReserve64: {
      readonly batches: number
      readonly attemptedPerBatch: typeof CONTENTION
      readonly acceptedPerBatch: 6
      readonly deniedPerBatch: 58
      readonly ledgerWritesPerBatch: 6
    }
  }
}

export interface RunBenchmarkOptions {
  readonly iterations?: number
  readonly warmup?: number
  readonly clock?: BenchmarkClock
}

interface MemoryRow {
  readonly admittedTotal: number
  readonly admittedChildrenByParent: Readonly<Record<string, number>>
}

class InstrumentedMemoryLedger implements AdmissionLedger {
  readonly rows = new Map<string, MemoryRow>()
  writes = 0

  async reserveNew(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<MemoryRow> {
    const current = this.rows.get(input.rootSessionId)
    const admittedTotal = current?.admittedTotal ?? 0
    const parentCount = current?.admittedChildrenByParent[input.parentSessionId] ?? 0
    if (admittedTotal >= input.limits.perRootAdmittedTotal) {
      throw new LedgerOperationalError(
        'ROOT_TOTAL_LIMIT',
        input.rootSessionId,
        input.parentSessionId,
        admittedTotal,
        input.limits.perRootAdmittedTotal,
      )
    }
    if (parentCount >= input.limits.perParentChildren) {
      throw new LedgerOperationalError(
        'PARENT_CHILD_LIMIT',
        input.rootSessionId,
        input.parentSessionId,
        parentCount,
        input.limits.perParentChildren,
      )
    }
    assertActiveCapacity()
    const admittedChildrenByParent = Object.freeze({
      ...current?.admittedChildrenByParent,
      [input.parentSessionId]: parentCount + 1,
    })
    const next = Object.freeze({
      admittedTotal: admittedTotal + 1,
      admittedChildrenByParent,
    })
    this.rows.set(input.rootSessionId, next)
    this.writes += 1
    return next
  }

  read(rootId: string): MemoryRow | undefined {
    return this.rows.get(rootId)
  }
}

class BenchmarkRoots implements RootResolution {
  private readonly bindings = new Map<string, string>()

  async resolve(parentSessionId: string): Promise<ResolvedLineage> {
    const separator = parentSessionId.indexOf('::')
    const rootSessionId = separator < 0
      ? parentSessionId
      : parentSessionId.slice(0, separator)
    if (rootSessionId.length === 0) {
      throw Object.freeze({ code: 'ADMISSION_UNAVAILABLE' })
    }
    return Object.freeze({
      rootSessionId,
      lineage: Object.freeze(
        rootSessionId === parentSessionId
          ? [rootSessionId]
          : [parentSessionId, rootSessionId],
      ),
    })
  }

  bindChild(input: ChildBindingInput): void {
    if (
      input.localParentSessionId !== undefined
      && input.localParentSessionId !== input.expectedParentSessionId
    ) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    const existing = this.bindings.get(input.childSessionId)
    if (existing !== undefined && existing !== input.expectedRootSessionId) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    this.bindings.set(input.childSessionId, input.expectedRootSessionId)
  }
}

class BenchmarkFixture {
  readonly ledger = new InstrumentedMemoryLedger()
  readonly leases = new ActiveLeaseRegistry()
  readonly roots = new BenchmarkRoots()
  readonly telemetry: AdmissionTelemetry
  readonly authority: AdmissionAuthority
  private requestCounter = 0
  private authorityTime = 1

  constructor(readonly limits: AdmissionLimits) {
    let telemetry!: AdmissionTelemetry
    this.authority = new AdmissionAuthority({
      limits,
      policyEpoch: 'benchmark-protocol-v1',
      roots: this.roots,
      ledger: this.ledger,
      leases: this.leases,
      guard: { assertHeld: async (): Promise<void> => {} },
      clock: { now: (): number => this.authorityTime++ },
      onEvent: (event: AdmissionAuthorityEvent): void => {
        telemetry.record({
          kind: event.kind,
          time: event.time,
          requestId: event.requestId,
          operation: event.operation,
          rootId: event.rootId,
          parentSessionId: event.parentSessionId,
          childSessionId: event.childSessionId,
          code: event.code,
          duplicate: event.duplicate,
        })
      },
    })
    telemetry = new AdmissionTelemetry({
      epoch: 'benchmark-epoch',
      limits,
      readStatus: () => ({ mode: 'strict', enforced: true, reason: null }),
      readLeases: () => this.leases.snapshot(),
      readRootLedger: (rootId) => {
        const row = this.ledger.read(rootId)
        return row === undefined
          ? undefined
          : {
              rootSessionId: rootId,
              admittedTotal: row.admittedTotal,
              admittedChildrenByParent: row.admittedChildrenByParent,
            }
      },
      resolveRoot: (sessionId) => {
        const separator = sessionId.indexOf('::')
        return separator < 0 ? sessionId : sessionId.slice(0, separator)
      },
      clock: { now: (): number => this.authorityTime++ },
    })
    this.telemetry = telemetry
  }

  request(
    operation: SubagentAdmissionRequestV1['operation'],
    parentSessionId: string,
    childSessionId?: string,
  ): SubagentAdmissionRequestV1 {
    this.requestCounter += 1
    return Object.freeze({
      requestId: `benchmark-request-${String(this.requestCounter)}`,
      operation,
      provider: 'benchmark-fake-provider',
      parentSessionId,
      ...(childSessionId === undefined ? {} : { childSessionId }),
    })
  }
}

function benchmarkLimits(iterations: number, warmup: number): AdmissionLimits {
  const cumulative = Math.max(256, (iterations + warmup + 1) * 64)
  return Object.freeze({
    globalActive: 6,
    perRootActive: 4,
    perRootAdmittedTotal: cumulative,
    perParentChildren: cumulative,
  })
}

function assertRunCount(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 10_000) {
    throw new Error(`${label} must be an integer from ${String(minimum)} to 10000`)
  }
}

function nanosecondsBetween(start: bigint, end: bigint): number {
  const elapsed = end - start
  if (elapsed < 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('benchmark clock must be monotonic with safe nanosecond deltas')
  }
  return Number(elapsed)
}

async function collectSamples<T>(
  iterations: number,
  clock: BenchmarkClock,
  operation: (index: number) => Promise<T> | T,
): Promise<{ readonly samples: readonly number[]; readonly values: readonly T[] }> {
  const samples: number[] = []
  const values: T[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = clock.now()
    const value = await operation(index)
    const end = clock.now()
    samples.push(nanosecondsBetween(start, end))
    values.push(value)
  }
  return {
    samples: Object.freeze(samples),
    values: Object.freeze(values),
  }
}

function collectSyncSamples(
  iterations: number,
  clock: BenchmarkClock,
  operation: (index: number) => void,
): readonly number[] {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = clock.now()
    operation(index)
    const end = clock.now()
    samples.push(nanosecondsBetween(start, end))
  }
  return Object.freeze(samples)
}

async function collectPrepareSamples(
  iterations: number,
  clock: BenchmarkClock,
  prepare: (index: number) => Promise<SubagentAdmissionPermitV1>,
): Promise<readonly number[]> {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = clock.now()
    const permit = await prepare(index)
    const end = clock.now()
    samples.push(nanosecondsBetween(start, end))
    await permit.release('completed')
  }
  return Object.freeze(samples)
}

async function warm(
  count: number,
  operation: (index: number) => Promise<unknown> | unknown,
): Promise<void> {
  for (let index = 0; index < count; index += 1) await operation(index)
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error('percentile requires non-empty samples')
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error('percentile quantile must be in (0, 1]')
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[index]!
}

function summarize(samples: readonly number[]): BenchmarkSummary {
  const total = samples.reduce((sum, sample) => sum + sample, 0)
  return Object.freeze({
    min: Math.min(...samples),
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
    mean: total / samples.length,
  })
}

function measuredCase(
  boundary: string,
  samples: readonly number[],
): BenchmarkCase {
  return Object.freeze({
    unit: 'nanoseconds',
    boundary,
    samples,
    summary: summarize(samples),
  })
}

function denialCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

async function expectGlobalDenial(
  fixture: BenchmarkFixture,
  parentSessionId: string,
): Promise<void> {
  try {
    await fixture.authority.prepare(
      fixture.request('new-one-shot', parentSessionId),
    )
  } catch (error) {
    if (denialCode(error) === 'GLOBAL_ACTIVE_LIMIT') return
    throw error
  }
  throw new Error('denied benchmark unexpectedly accepted work')
}

async function benchmarkDenied(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{ readonly measured: BenchmarkCase; readonly writes: 0 }> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  const held: SubagentAdmissionPermitV1[] = []
  for (let index = 0; index < 6; index += 1) {
    held.push(await fixture.authority.prepare(fixture.request(
      'new-one-shot',
      `root-${index % 2 === 0 ? 'a' : 'b'}::holder-${index}`,
    )))
  }
  await warm(warmup, index => expectGlobalDenial(
    fixture,
    `root-c::warm-denied-${index}`,
  ))
  const writesBefore = fixture.ledger.writes
  const { samples } = await collectSamples(iterations, clock, index =>
    expectGlobalDenial(fixture, `root-c::denied-${index}`),
  )
  if (fixture.ledger.writes !== writesBefore) {
    throw new Error('capacity denial performed a ledger write')
  }
  await Promise.all(held.map(permit => permit.release('disposed')))
  return {
    measured: measuredCase('prepare rejection before provider/materialization work', samples),
    writes: 0,
  }
}

async function benchmarkAcceptedNew(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{ readonly measured: BenchmarkCase; readonly writes: number }> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  const run = async (index: number, phase: string): Promise<void> => {
    const permit = await fixture.authority.prepare(fixture.request(
      'new-one-shot',
      `root-accepted::${phase}-${index}`,
    ))
    await permit.release('completed')
  }
  await warm(warmup, index => run(index, 'warm'))
  const writesBefore = fixture.ledger.writes
  const samples = await collectPrepareSamples(iterations, clock, index =>
    fixture.authority.prepare(fixture.request(
      'new-one-shot',
      `root-accepted::measured-${index}`,
    )),
  )
  const writes = fixture.ledger.writes - writesBefore
  if (writes !== iterations) {
    throw new Error(`accepted new path wrote ${writes} rows instead of ${iterations}`)
  }
  return {
    measured: measuredCase('prepare through exactly one in-memory ledger write', samples),
    writes,
  }
}

async function benchmarkColdResume(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{ readonly measured: BenchmarkCase; readonly writes: 0 }> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  const run = async (index: number, phase: string): Promise<void> => {
    const permit = await fixture.authority.prepare(fixture.request(
      'cold-resume',
      `root-cold::${phase}-${index}`,
      `cold-child-${phase}-${index}`,
    ))
    await permit.release('completed')
  }
  await warm(warmup, index => run(index, 'warm'))
  const samples = await collectPrepareSamples(iterations, clock, index =>
    fixture.authority.prepare(fixture.request(
      'cold-resume',
      `root-cold::measured-${index}`,
      `cold-child-measured-${index}`,
    )),
  )
  if (fixture.ledger.writes !== 0) {
    throw new Error('cold resume performed a cumulative ledger write')
  }
  return {
    measured: measuredCase('cold-resume prepare without cumulative ledger write', samples),
    writes: 0,
  }
}

async function benchmarkRelease(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{ readonly measured: BenchmarkCase; readonly writes: 0 }> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  const releaseAfterOpenCleanup = async (index: number, phase: string): Promise<void> => {
    const permit = await fixture.authority.prepare(fixture.request(
      'cold-resume',
      `root-release::${phase}-${index}`,
      `release-child-${phase}-${index}`,
    ))
    const cleanupBoundary = Promise.resolve('opened')
    await cleanupBoundary
    await permit.release('completed')
  }
  await warm(warmup, index => releaseAfterOpenCleanup(index, 'warm'))
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const permit = await fixture.authority.prepare(fixture.request(
      'cold-resume',
      `root-release::measured-${index}`,
      `release-child-measured-${index}`,
    ))
    await Promise.resolve('cleanup-opened')
    const start = clock.now()
    await permit.release('completed')
    const end = clock.now()
    samples.push(nanosecondsBetween(start, end))
  }
  if (fixture.ledger.writes !== 0) {
    throw new Error('release benchmark performed a cumulative ledger write')
  }
  return {
    measured: measuredCase(
      'permit release after the external cleanup boundary is open',
      Object.freeze(samples),
    ),
    writes: 0,
  }
}

async function benchmarkSnapshots(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{
  readonly get: BenchmarkCase
  readonly watch: BenchmarkCase
}> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  const read = (): void => { void fixture.telemetry.snapshot('root-snapshot') }
  const watch = async (): Promise<void> => {
    await fixture.telemetry.watch({
      sessionId: 'root-snapshot',
      epoch: 'stale-epoch',
      revision: fixture.telemetry.revision,
      timeoutMs: 30_000,
    }, new AbortController().signal)
  }
  await warm(warmup, read)
  const get = collectSyncSamples(iterations, clock, read)
  await warm(warmup, watch)
  const watched = await collectSamples(iterations, clock, watch)
  if (fixture.ledger.writes !== 0) {
    throw new Error('snapshot projection performed a cumulative ledger write')
  }
  return {
    get: measuredCase('synchronous full read-only snapshot projection', get),
    watch: measuredCase('full snapshot from a stale-epoch watch request', watched.samples),
  }
}

interface RaceResult {
  readonly accepted: readonly SubagentAdmissionPermitV1[]
  readonly denied: number
}

async function runRaceBatch(
  fixture: BenchmarkFixture,
  batch: string,
): Promise<RaceResult> {
  const settled = await Promise.allSettled(
    Array.from({ length: CONTENTION }, (_, index) =>
      fixture.authority.prepare(fixture.request(
        'new-one-shot',
        `race-root-${index % 16}::${batch}-${index}`,
      )),
    ),
  )
  const accepted: SubagentAdmissionPermitV1[] = []
  let denied = 0
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      accepted.push(result.value)
    } else if (denialCode(result.reason) === 'GLOBAL_ACTIVE_LIMIT') {
      denied += 1
    } else {
      throw result.reason
    }
  }
  if (accepted.length !== 6 || denied !== 58) {
    throw new Error(`64-way race produced ${accepted.length} accepted and ${denied} denied`)
  }
  return { accepted: Object.freeze(accepted), denied }
}

async function benchmarkConcurrentReserve(
  iterations: number,
  warmup: number,
  clock: BenchmarkClock,
): Promise<{ readonly measured: BenchmarkCase; readonly writesPerBatch: 6 }> {
  const fixture = new BenchmarkFixture(benchmarkLimits(iterations, warmup))
  for (let index = 0; index < warmup; index += 1) {
    const result = await runRaceBatch(fixture, `warm-${index}`)
    await Promise.all(result.accepted.map(permit => permit.release('completed')))
  }
  const writesBefore = fixture.ledger.writes
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = clock.now()
    const result = await runRaceBatch(fixture, `measured-${index}`)
    const end = clock.now()
    samples.push(nanosecondsBetween(start, end))
    await Promise.all(result.accepted.map(permit => permit.release('completed')))
  }
  const writes = fixture.ledger.writes - writesBefore
  if (writes !== iterations * 6) {
    throw new Error(`64-way races wrote ${writes} rows instead of ${iterations * 6}`)
  }
  return {
    measured: measuredCase(
      '64 concurrent prepares through the serialized capacity decision',
      Object.freeze(samples),
    ),
    writesPerBatch: 6,
  }
}

function packageVersions(): { readonly plugin: string; readonly dsh: string } {
  const plugin = JSON.parse(readFileSync(PACKAGE_MANIFEST, 'utf8')) as { version?: unknown }
  const require = createRequire(resolve(WORKSPACE_ROOT, 'package.json'))
  const dshManifest = JSON.parse(
    readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
  ) as { version?: unknown }
  if (typeof plugin.version !== 'string' || typeof dshManifest.version !== 'string') {
    throw new Error('benchmark package identity is incomplete')
  }
  return { plugin: plugin.version, dsh: dshManifest.version }
}

export async function runBenchmark(
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const iterations = options.iterations ?? 100
  const warmup = options.warmup ?? 10
  assertRunCount(iterations, 'iterations', 1)
  assertRunCount(warmup, 'warmup', 0)
  const clock = options.clock ?? { now: process.hrtime.bigint }

  const denied = await benchmarkDenied(iterations, warmup, clock)
  const accepted = await benchmarkAcceptedNew(iterations, warmup, clock)
  const cold = await benchmarkColdResume(iterations, warmup, clock)
  const released = await benchmarkRelease(iterations, warmup, clock)
  const snapshots = await benchmarkSnapshots(iterations, warmup, clock)
  const concurrent = await benchmarkConcurrentReserve(iterations, warmup, clock)
  const versions = packageVersions()
  const processors = cpus()

  return Object.freeze({
    schemaVersion: 1,
    status: 'measured',
    generatedAt: new Date().toISOString(),
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: processors[0]?.model ?? 'unknown',
      cpuCount: processors.length,
      pluginVersion: versions.plugin,
      dshPackageVersion: versions.dsh,
      storage: 'in-memory-instrumented',
      measurementClock: options.clock === undefined
        ? 'process.hrtime.bigint'
        : 'injected-monotonic-bigint',
    }),
    parameters: Object.freeze({ iterations, warmup, contention: CONTENTION }),
    cases: Object.freeze({
      denied: denied.measured,
      acceptedNew: accepted.measured,
      coldResume: cold.measured,
      releaseAfterCleanup: released.measured,
      snapshotGet: snapshots.get,
      snapshotWatch: snapshots.watch,
      concurrentReserve64: concurrent.measured,
    }),
    operationBudgets: Object.freeze({
      denied: Object.freeze({ accepted: 0, denied: iterations, ledgerWrites: 0 }),
      acceptedNew: Object.freeze({ accepted: iterations, denied: 0, ledgerWrites: accepted.writes }),
      coldResume: Object.freeze({ accepted: iterations, denied: 0, ledgerWrites: 0 }),
      releaseAfterCleanup: Object.freeze({ releases: iterations, ledgerWrites: 0 }),
      snapshotGet: Object.freeze({ ledgerWrites: 0 }),
      snapshotWatch: Object.freeze({ ledgerWrites: 0 }),
      concurrentReserve64: Object.freeze({
        batches: iterations,
        attemptedPerBatch: CONTENTION,
        acceptedPerBatch: 6,
        deniedPerBatch: 58,
        ledgerWritesPerBatch: concurrent.writesPerBatch,
      }),
    }),
  })
}

interface CliOptions {
  readonly iterations: number
  readonly warmup: number
  readonly output?: string
}

function parseInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${flag} needs a non-negative integer`)
  }
  return Number(value)
}

function parseCli(rawArgv: readonly string[]): CliOptions {
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv
  let iterations = 100
  let warmup = 10
  let output: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--iterations') iterations = parseInteger(argv[++index], arg)
    else if (arg === '--warmup') warmup = parseInteger(argv[++index], arg)
    else if (arg === '--output') {
      output = argv[++index]
      if (output === undefined || output.length === 0) throw new Error('--output needs a path')
    } else {
      throw new Error(`unknown benchmark argument ${String(arg)}`)
    }
  }
  return { iterations, warmup, ...(output === undefined ? {} : { output }) }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2))
    const report = await runBenchmark(options)
    const rendered = `${JSON.stringify(report, null, 2)}\n`
    if (options.output !== undefined) {
      const outputPath = resolve(options.output)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, rendered)
    }
    process.stdout.write(rendered)
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}
