#!/usr/bin/env tsx
/** Safe, no-model structural reproduction of DeepSeek Harness Discussion #131. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
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
import { fileURLToPath } from 'node:url'

import {
  AdmissionAuthority,
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
import type { AdmissionLimits } from '../packages/dsh-subagent-admission/src/types.js'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_PATH)
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_CHILDREN = 56
const DEFAULT_SESSION_WRITES = 8
const DEFAULT_STOCK_TIMEOUT_MS = 15_000
const DEFAULT_STOCK_OLD_SPACE_MIB = 128
const MAX_CHILD_OUTPUT = 2 * 1024 * 1024
const TEMP_PREFIX = 'dsh-reproduce-131-'
const ROOT_ID = 'discussion-131-root'
const DEFAULT_LIMITS: AdmissionLimits = Object.freeze({
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
})

type ProviderKind = 'spawn' | 'fork'

interface WorkNode {
  readonly id: string
  readonly parentId: string
  readonly provider: ProviderKind
  readonly operation: 'new-continuable'
  readonly scheduling: 'background'
}

interface HeldProviderRun {
  finish(): void
}

interface StrictShapeResult {
  readonly mode: 'strict'
  readonly enforced: true
  readonly requestedChildren: number
  readonly policyAttempts: number
  readonly accepted: number
  readonly denied: number
  readonly suppressedDescendants: number
  readonly providerStarts: number
  readonly providerStartsByKind: Readonly<Record<ProviderKind, number>>
  readonly peakGlobalActive: number
  readonly peakRootActive: number
  readonly sessionWrites: number
  readonly journalFiles: number
  readonly journalBytes: number
  readonly sessionWriteSurface: 'filesystem-jsonl-fixture'
  readonly ledgerWrites: number
  readonly deniedByCode: Readonly<Record<string, number>>
  readonly globalProbe: {
    readonly attempted: 7
    readonly accepted: 6
    readonly deniedCode: 'GLOBAL_ACTIVE_LIMIT'
    readonly providerStarts: 6
    readonly activeByRootBeforeDenial: Readonly<Record<string, number>>
  }
}

interface StockWorkerResult {
  readonly schemaVersion: 1
  readonly status: 'pass'
  readonly mode: 'audit'
  readonly enforced: false
  readonly executionSurface: 'scripted-provider-policy-absent-baseline'
  readonly attempted: number
  readonly accepted: number
  readonly denied: 0
  readonly providerStarts: number
  readonly providerStartsByKind: Readonly<Record<ProviderKind, number>>
  readonly peakGlobalActive: number
  readonly sessionWrites: number
  readonly journalFiles: number
  readonly journalBytes: number
  readonly sessionWriteSurface: 'filesystem-jsonl-fixture'
  readonly journalSha256: string
  readonly rssAfterStartsBytes: number
  readonly heapUsedAfterStartsBytes: number
}

export interface Reproduction131Report {
  readonly schemaVersion: 1
  readonly status: 'measured'
  readonly generatedAt: string
  readonly discussion: 'https://github.com/deepseek-ai/deepseek-harness/discussions/131'
  readonly environment: {
    readonly node: string
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly pluginVersion: string
    readonly dshPackageVersion: string
    readonly strictSourceCommit: string
    readonly strictSourcePackageVersion: string
    readonly executionSurface: 'admission-seam-structural-fixture'
  }
  readonly shape: {
    readonly requestedChildren: number
    readonly topology: 'binary-nested'
    readonly providers: readonly ['spawn', 'fork']
    readonly operation: 'new-continuable'
    readonly scheduling: 'background'
    readonly sessionWritesPerAcceptedChild: number
    readonly sessionWriteSurface: 'filesystem-jsonl-fixture'
    readonly externalModelCalls: 0
    readonly apiKeysRequired: false
  }
  readonly safety: {
    readonly stockStressAuthorized: boolean
    readonly stockStressExecuted: boolean
    readonly stockRunsBeforeStrict: true
    readonly hardProcessTimeout: true
    readonly v8OldSpaceCeiling: true
    readonly externalNetworkRequests: 0
  }
  readonly stock?: StockWorkerResult & {
    readonly worker: {
      readonly timedOut: false
      readonly exitCode: 0
      readonly timeoutMs: number
      readonly v8OldSpaceMib: number
      readonly stderrSha256: string
    }
  }
  readonly strict: StrictShapeResult
}

export interface RunReproduction131Options {
  readonly strictOnly?: boolean
  readonly allowStockStress?: boolean
  readonly requestedChildren?: number
  readonly sessionWritesPerChild?: number
  readonly stockTimeoutMs?: number
  readonly stockOldSpaceMib?: number
}

interface LedgerRow {
  readonly admittedTotal: number
  readonly admittedChildrenByParent: Readonly<Record<string, number>>
}

class ReproductionLedger implements AdmissionLedger {
  readonly rows = new Map<string, LedgerRow>()
  writes = 0

  async reserveNew(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<LedgerRow> {
    const current = this.rows.get(input.rootSessionId)
    const rootCount = current?.admittedTotal ?? 0
    const parentCount = current?.admittedChildrenByParent[input.parentSessionId] ?? 0
    if (rootCount >= input.limits.perRootAdmittedTotal) {
      throw new LedgerOperationalError(
        'ROOT_TOTAL_LIMIT', input.rootSessionId, input.parentSessionId,
        rootCount, input.limits.perRootAdmittedTotal,
      )
    }
    if (parentCount >= input.limits.perParentChildren) {
      throw new LedgerOperationalError(
        'PARENT_CHILD_LIMIT', input.rootSessionId, input.parentSessionId,
        parentCount, input.limits.perParentChildren,
      )
    }
    assertActiveCapacity()
    const next = Object.freeze({
      admittedTotal: rootCount + 1,
      admittedChildrenByParent: Object.freeze({
        ...current?.admittedChildrenByParent,
        [input.parentSessionId]: parentCount + 1,
      }),
    })
    this.rows.set(input.rootSessionId, next)
    this.writes += 1
    return next
  }
}

class TopologyRoots implements RootResolution {
  private readonly roots = new Map<string, string>()

  constructor(rootIds: readonly string[]) {
    for (const rootId of rootIds) this.roots.set(rootId, rootId)
  }

  has(sessionId: string): boolean {
    return this.roots.has(sessionId)
  }

  async resolve(parentSessionId: string): Promise<ResolvedLineage> {
    const rootSessionId = this.roots.get(parentSessionId)
    if (rootSessionId === undefined) {
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
    const parentRoot = this.roots.get(input.expectedParentSessionId)
    if (parentRoot !== input.expectedRootSessionId) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    const existing = this.roots.get(input.childSessionId)
    if (existing !== undefined && existing !== input.expectedRootSessionId) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    this.roots.set(input.childSessionId, input.expectedRootSessionId)
  }
}

class ScriptedProvider {
  private readonly journal: string[] = []
  private readonly files = new Set<string>()
  private bytes = 0
  private active = 0
  starts = 0
  peakActive = 0
  readonly startsByKind: Record<ProviderKind, number> = { spawn: 0, fork: 0 }

  constructor(
    private readonly sessionWritesPerChild: number,
    private readonly journalRoot: string,
  ) {}

  start(node: WorkNode): HeldProviderRun {
    this.starts += 1
    this.startsByKind[node.provider] += 1
    this.active += 1
    this.peakActive = Math.max(this.peakActive, this.active)
    if (!/^[a-z0-9-]+$/.test(node.id)) {
      throw new Error(`unsafe scripted session id ${node.id}`)
    }
    const journalPath = resolve(this.journalRoot, `${node.id}.jsonl`)
    for (let write = 0; write < this.sessionWritesPerChild; write += 1) {
      const line = `${JSON.stringify({
        schemaVersion: 1,
        sessionId: node.id,
        parentSessionId: node.parentId,
        provider: node.provider,
        sequence: write + 1,
        event: 'session/write',
      })}\n`
      appendFileSync(journalPath, line, 'utf8')
      this.journal.push(line)
      this.bytes += Buffer.byteLength(line)
      this.files.add(journalPath)
    }
    let finished = false
    return Object.freeze({
      finish: (): void => {
        if (finished) return
        finished = true
        this.active -= 1
      },
    })
  }

  get sessionWrites(): number {
    return this.journal.length
  }

  get journalFiles(): number {
    return this.files.size
  }

  get journalBytes(): number {
    return this.bytes
  }

  journalSha256(): string {
    return createHash('sha256').update(this.journal.join('')).digest('hex')
  }
}

function createJournalRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${label}-`))
}

function assertJournalRoot(path: string): void {
  const absoluteTmp = resolve(tmpdir())
  const absolute = resolve(path)
  const fromTmp = relative(absoluteTmp, absolute)
  if (
    !isAbsolute(path)
    || fromTmp.length === 0
    || isAbsolute(fromTmp)
    || fromTmp.startsWith('..')
    || !basename(absolute).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`refusing unsafe reproduction journal root ${path}`)
  }
}

function removeJournalRoot(path: string): void {
  assertJournalRoot(path)
  rmSync(path, { recursive: true, force: true })
}

function buildTopology(requestedChildren: number): readonly WorkNode[] {
  return Object.freeze(Array.from({ length: requestedChildren }, (_, index) => {
    const oneBased = index + 1
    const parentIndex = Math.floor((oneBased - 2) / 2) + 1
    return Object.freeze({
      id: `discussion-131-child-${oneBased}`,
      parentId: oneBased === 1 ? ROOT_ID : `discussion-131-child-${parentIndex}`,
      provider: oneBased % 2 === 0 ? 'fork' : 'spawn',
      operation: 'new-continuable',
      scheduling: 'background',
    })
  }))
}

function codeOf(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  throw error
}

function requestFor(node: WorkNode, index: number): SubagentAdmissionRequestV1 {
  return Object.freeze({
    requestId: `discussion-131-request-${index + 1}`,
    operation: node.operation,
    provider: node.provider,
    parentSessionId: node.parentId,
    childSessionId: node.id,
  })
}

function makeAuthority(
  roots: TopologyRoots,
  ledger: ReproductionLedger,
  leases: ActiveLeaseRegistry,
): AdmissionAuthority {
  let now = 1
  return new AdmissionAuthority({
    limits: DEFAULT_LIMITS,
    policyEpoch: 'discussion-131-protocol-v1',
    roots,
    ledger,
    leases,
    guard: { assertHeld: async (): Promise<void> => {} },
    clock: { now: (): number => now++ },
  })
}

async function runStrictShape(
  topology: readonly WorkNode[],
  sessionWritesPerChild: number,
): Promise<StrictShapeResult> {
  const journalRoot = createJournalRoot('strict')
  try {
    return await runStrictShapeWithJournal(
      topology,
      sessionWritesPerChild,
      journalRoot,
    )
  } finally {
    removeJournalRoot(journalRoot)
  }
}

async function runStrictShapeWithJournal(
  topology: readonly WorkNode[],
  sessionWritesPerChild: number,
  journalRoot: string,
): Promise<StrictShapeResult> {
  const roots = new TopologyRoots([ROOT_ID])
  const ledger = new ReproductionLedger()
  const leases = new ActiveLeaseRegistry()
  const authority = makeAuthority(roots, ledger, leases)
  const provider = new ScriptedProvider(sessionWritesPerChild, journalRoot)
  const held: Array<{
    readonly permit: SubagentAdmissionPermitV1
    readonly run: HeldProviderRun
  }> = []
  const deniedByCode: Record<string, number> = Object.create(null) as Record<string, number>
  let policyAttempts = 0
  let suppressedDescendants = 0
  let peakRootActive = 0

  for (const [index, node] of topology.entries()) {
    if (!roots.has(node.parentId)) {
      suppressedDescendants += 1
      continue
    }
    policyAttempts += 1
    try {
      const permit = await authority.prepare(requestFor(node, index))
      permit.bindChild({
        childSessionId: node.id,
        localParentSessionId: node.parentId,
      })
      const run = provider.start(node)
      held.push({ permit, run })
      peakRootActive = Math.max(peakRootActive, leases.rootActive(ROOT_ID))
    } catch (error) {
      const code = codeOf(error)
      deniedByCode[code] = (deniedByCode[code] ?? 0) + 1
    }
  }

  for (const heldRun of held.reverse()) {
    heldRun.run.finish()
    await heldRun.permit.release('completed')
  }

  const denied = Object.values(deniedByCode).reduce((sum, count) => sum + count, 0)
  if (
    held.length > DEFAULT_LIMITS.perRootActive
    || provider.starts !== held.length
    || provider.peakActive > DEFAULT_LIMITS.globalActive
    || peakRootActive > DEFAULT_LIMITS.perRootActive
    || policyAttempts + suppressedDescendants !== topology.length
    || denied !== policyAttempts - held.length
  ) {
    throw new Error('Strict #131 shape violated admission invariants')
  }

  return Object.freeze({
    mode: 'strict',
    enforced: true,
    requestedChildren: topology.length,
    policyAttempts,
    accepted: held.length,
    denied,
    suppressedDescendants,
    providerStarts: provider.starts,
    providerStartsByKind: Object.freeze({ ...provider.startsByKind }),
    peakGlobalActive: provider.peakActive,
    peakRootActive,
    sessionWrites: provider.sessionWrites,
    journalFiles: provider.journalFiles,
    journalBytes: provider.journalBytes,
    sessionWriteSurface: 'filesystem-jsonl-fixture',
    ledgerWrites: ledger.writes,
    deniedByCode: Object.freeze({ ...deniedByCode }),
    globalProbe: await runGlobalProbe(journalRoot),
  })
}

async function runGlobalProbe(
  journalRoot: string,
): Promise<StrictShapeResult['globalProbe']> {
  const rootA = 'global-probe-root-a'
  const rootB = 'global-probe-root-b'
  const roots = new TopologyRoots([rootA, rootB])
  const ledger = new ReproductionLedger()
  const leases = new ActiveLeaseRegistry()
  const authority = makeAuthority(roots, ledger, leases)
  const provider = new ScriptedProvider(0, journalRoot)
  const held: Array<{
    readonly permit: SubagentAdmissionPermitV1
    readonly run: HeldProviderRun
  }> = []

  for (let index = 0; index < 6; index += 1) {
    const root = index % 2 === 0 ? rootA : rootB
    const node: WorkNode = {
      id: `global-probe-child-${index + 1}`,
      parentId: root,
      provider: index % 2 === 0 ? 'spawn' : 'fork',
      operation: 'new-continuable',
      scheduling: 'background',
    }
    const permit = await authority.prepare(requestFor(node, index))
    permit.bindChild({ childSessionId: node.id, localParentSessionId: root })
    held.push({ permit, run: provider.start(node) })
  }

  const deniedNode: WorkNode = {
    id: 'global-probe-child-7',
    parentId: rootA,
    provider: 'spawn',
    operation: 'new-continuable',
    scheduling: 'background',
  }
  let deniedCode = ''
  try {
    await authority.prepare(requestFor(deniedNode, 6))
  } catch (error) {
    deniedCode = codeOf(error)
  }
  const activeByRootBeforeDenial = Object.freeze({
    [rootA]: leases.rootActive(rootA),
    [rootB]: leases.rootActive(rootB),
  })
  for (const heldRun of held.reverse()) {
    heldRun.run.finish()
    await heldRun.permit.release('completed')
  }
  if (deniedCode !== 'GLOBAL_ACTIVE_LIMIT' || provider.starts !== 6) {
    throw new Error('global capacity probe did not fail before provider work')
  }
  return Object.freeze({
    attempted: 7,
    accepted: 6,
    deniedCode: 'GLOBAL_ACTIVE_LIMIT',
    providerStarts: 6,
    activeByRootBeforeDenial,
  })
}

function runStockWorkerBody(
  requestedChildren: number,
  sessionWritesPerChild: number,
  journalRoot: string,
): StockWorkerResult {
  assertJournalRoot(journalRoot)
  const topology = buildTopology(requestedChildren)
  const provider = new ScriptedProvider(sessionWritesPerChild, journalRoot)
  const runs = topology.map(node => provider.start(node))
  const memory = process.memoryUsage()
  for (const run of runs.reverse()) run.finish()
  if (provider.starts !== requestedChildren) {
    throw new Error('stock policy-absent baseline did not start every requested provider')
  }
  return Object.freeze({
    schemaVersion: 1,
    status: 'pass',
    mode: 'audit',
    enforced: false,
    executionSurface: 'scripted-provider-policy-absent-baseline',
    attempted: requestedChildren,
    accepted: requestedChildren,
    denied: 0,
    providerStarts: provider.starts,
    providerStartsByKind: Object.freeze({ ...provider.startsByKind }),
    peakGlobalActive: provider.peakActive,
    sessionWrites: provider.sessionWrites,
    journalFiles: provider.journalFiles,
    journalBytes: provider.journalBytes,
    sessionWriteSurface: 'filesystem-jsonl-fixture',
    journalSha256: provider.journalSha256(),
    rssAfterStartsBytes: memory.rss,
    heapUsedAfterStartsBytes: memory.heapUsed,
  })
}

interface StockWorkerControls {
  readonly timeoutMs: number
  readonly oldSpaceMib: number
}

async function runStockWorker(
  requestedChildren: number,
  sessionWritesPerChild: number,
  controls: StockWorkerControls,
): Promise<NonNullable<Reproduction131Report['stock']>> {
  const journalRoot = createJournalRoot('stock')
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (/(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key)) delete environment[key]
  }
  environment.DSH_TELEMETRY_DISABLED = '1'
  const args = [
    `--max-old-space-size=${controls.oldSpaceMib}`,
    '--import',
    'tsx/esm',
    SCRIPT_PATH,
    '--stock-worker',
    '--children',
    String(requestedChildren),
    '--session-writes',
    String(sessionWritesPerChild),
    '--journal-root',
    journalRoot,
  ]

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: WORKSPACE_ROOT,
      env: environment as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, controls.timeoutMs)

    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeJournalRoot(journalRoot)
      rejectPromise(error)
    }
    child.on('error', error => rejectOnce(error))
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_CHILD_OUTPUT) {
        child.kill('SIGKILL')
        rejectOnce(new Error('stock worker exceeded its output limit'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_CHILD_OUTPUT) stderr = stderr.slice(-MAX_CHILD_OUTPUT)
    })
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      if (timedOut) {
        rejectOnce(new Error(`stock worker exceeded hard timeout ${controls.timeoutMs}ms`))
        return
      }
      if (code !== 0) {
        rejectOnce(new Error(
          `stock worker failed with exit code ${String(code)}: ${stderr.slice(-2_000)}`,
        ))
        return
      }
      let parsed: StockWorkerResult
      try {
        parsed = JSON.parse(stdout) as StockWorkerResult
      } catch {
        rejectOnce(new Error('stock worker returned malformed JSON'))
        return
      }
      if (
        parsed.schemaVersion !== 1
        || parsed.status !== 'pass'
        || parsed.mode !== 'audit'
        || parsed.enforced !== false
        || parsed.providerStarts !== requestedChildren
      ) {
        rejectOnce(new Error('stock worker evidence failed validation'))
        return
      }
      settled = true
      removeJournalRoot(journalRoot)
      resolvePromise(Object.freeze({
        ...parsed,
        worker: Object.freeze({
          timedOut: false,
          exitCode: 0,
          timeoutMs: controls.timeoutMs,
          v8OldSpaceMib: controls.oldSpaceMib,
          stderrSha256: createHash('sha256').update(stderr).digest('hex'),
        }),
      }))
    })
  })
}

function assertInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
}

function readIdentity(): Reproduction131Report['environment'] {
  const plugin = JSON.parse(readFileSync(
    resolve(WORKSPACE_ROOT, 'packages/dsh-subagent-admission/package.json'),
    'utf8',
  )) as { version?: unknown }
  const baseline = JSON.parse(readFileSync(
    resolve(WORKSPACE_ROOT, 'compatibility/baseline.json'),
    'utf8',
  )) as {
    source?: { commit?: unknown; packageVersion?: unknown }
    strictTargets?: readonly { sourceCommit?: unknown; sourcePackageVersion?: unknown }[]
  }
  const require = createRequire(resolve(WORKSPACE_ROOT, 'package.json'))
  const dsh = JSON.parse(readFileSync(
    require.resolve('@deepseek-ai/dsh/package.json'),
    'utf8',
  )) as { version?: unknown }
  const target = baseline.strictTargets?.find(candidate =>
    candidate.sourceCommit === baseline.source?.commit,
  )
  if (
    typeof plugin.version !== 'string'
    || typeof dsh.version !== 'string'
    || typeof target?.sourceCommit !== 'string'
    || typeof target.sourcePackageVersion !== 'string'
  ) {
    throw new Error('reproduction identity is incomplete')
  }
  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pluginVersion: plugin.version,
    dshPackageVersion: dsh.version,
    strictSourceCommit: target.sourceCommit,
    strictSourcePackageVersion: target.sourcePackageVersion,
    executionSurface: 'admission-seam-structural-fixture',
  })
}

export async function runReproduction131(
  options: RunReproduction131Options = {},
): Promise<Reproduction131Report> {
  const strictOnly = options.strictOnly ?? false
  const allowStockStress = options.allowStockStress ?? false
  const requestedChildren = options.requestedChildren ?? DEFAULT_CHILDREN
  const sessionWritesPerChild = options.sessionWritesPerChild ?? DEFAULT_SESSION_WRITES
  const stockTimeoutMs = options.stockTimeoutMs ?? DEFAULT_STOCK_TIMEOUT_MS
  const stockOldSpaceMib = options.stockOldSpaceMib ?? DEFAULT_STOCK_OLD_SPACE_MIB
  assertInteger(requestedChildren, 'requestedChildren', 1, 10_000)
  assertInteger(sessionWritesPerChild, 'sessionWritesPerChild', 1, 1_000)
  assertInteger(stockTimeoutMs, 'stockTimeoutMs', 1_000, 120_000)
  assertInteger(stockOldSpaceMib, 'stockOldSpaceMib', 32, 4_096)
  if (!strictOnly && !allowStockStress) {
    throw new Error('stock Audit workload requires explicit --allow-stock-stress')
  }

  const topology = buildTopology(requestedChildren)
  const stock = strictOnly
    ? undefined
    : await runStockWorker(requestedChildren, sessionWritesPerChild, {
        timeoutMs: stockTimeoutMs,
        oldSpaceMib: stockOldSpaceMib,
      })
  const strict = await runStrictShape(topology, sessionWritesPerChild)

  return Object.freeze({
    schemaVersion: 1,
    status: 'measured',
    generatedAt: new Date().toISOString(),
    discussion: 'https://github.com/deepseek-ai/deepseek-harness/discussions/131',
    environment: readIdentity(),
    shape: Object.freeze({
      requestedChildren,
      topology: 'binary-nested',
      providers: Object.freeze(['spawn', 'fork'] as const),
      operation: 'new-continuable',
      scheduling: 'background',
      sessionWritesPerAcceptedChild: sessionWritesPerChild,
      sessionWriteSurface: 'filesystem-jsonl-fixture',
      externalModelCalls: 0,
      apiKeysRequired: false,
    }),
    safety: Object.freeze({
      stockStressAuthorized: allowStockStress,
      stockStressExecuted: stock !== undefined,
      stockRunsBeforeStrict: true,
      hardProcessTimeout: true,
      v8OldSpaceCeiling: true,
      externalNetworkRequests: 0,
    }),
    ...(stock === undefined ? {} : { stock }),
    strict,
  })
}

interface ParsedWorkerOptions {
  readonly children: number
  readonly sessionWrites: number
  readonly journalRoot: string
}

function parseWorker(argv: readonly string[]): ParsedWorkerOptions {
  let children: number | undefined
  let sessionWrites: number | undefined
  let journalRoot: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--children') children = Number(argv[++index])
    else if (arg === '--session-writes') sessionWrites = Number(argv[++index])
    else if (arg === '--journal-root') journalRoot = argv[++index]
    else throw new Error(`unknown stock worker argument ${String(arg)}`)
  }
  assertInteger(children ?? Number.NaN, 'children', 1, 10_000)
  assertInteger(sessionWrites ?? Number.NaN, 'sessionWrites', 1, 1_000)
  if (journalRoot === undefined) throw new Error('--journal-root needs a path')
  assertJournalRoot(journalRoot)
  return { children: children!, sessionWrites: sessionWrites!, journalRoot }
}

interface ParsedCli extends RunReproduction131Options {
  readonly output?: string
}

function parseValue(argv: readonly string[], index: number, flag: string): number {
  const value = argv[index]
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} needs an integer`)
  return Number(value)
}

function parseCli(rawArgv: readonly string[]): ParsedCli {
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv
  let strictOnly = false
  let allowStockStress = false
  let requestedChildren = DEFAULT_CHILDREN
  let sessionWritesPerChild = DEFAULT_SESSION_WRITES
  let stockTimeoutMs = DEFAULT_STOCK_TIMEOUT_MS
  let stockOldSpaceMib = DEFAULT_STOCK_OLD_SPACE_MIB
  let output: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--strict-only') strictOnly = true
    else if (arg === '--allow-stock-stress') allowStockStress = true
    else if (arg === '--children') requestedChildren = parseValue(argv, ++index, arg)
    else if (arg === '--session-writes') sessionWritesPerChild = parseValue(argv, ++index, arg)
    else if (arg === '--stock-timeout-ms') stockTimeoutMs = parseValue(argv, ++index, arg)
    else if (arg === '--stock-old-space-mib') stockOldSpaceMib = parseValue(argv, ++index, arg)
    else if (arg === '--output') {
      output = argv[++index]
      if (output === undefined || output.length === 0) throw new Error('--output needs a path')
    } else throw new Error(`unknown reproduction argument ${String(arg)}`)
  }
  if (strictOnly && allowStockStress) {
    throw new Error('--strict-only and --allow-stock-stress are mutually exclusive')
  }
  return {
    strictOnly,
    allowStockStress,
    requestedChildren,
    sessionWritesPerChild,
    stockTimeoutMs,
    stockOldSpaceMib,
    ...(output === undefined ? {} : { output }),
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === SCRIPT_PATH) {
  try {
    const rawArgv = process.argv.slice(2)
    if (rawArgv[0] === '--stock-worker') {
      const worker = parseWorker(rawArgv)
      process.stdout.write(JSON.stringify(
        runStockWorkerBody(worker.children, worker.sessionWrites, worker.journalRoot),
      ))
    } else {
      const options = parseCli(rawArgv)
      if (!options.strictOnly && options.allowStockStress) {
        console.error(JSON.stringify({
          confirmation: 'running bounded stock Audit structural workload before Strict',
          requestedChildren: options.requestedChildren,
          timeoutMs: options.stockTimeoutMs,
          v8OldSpaceMib: options.stockOldSpaceMib,
          modelCalls: 0,
        }))
      }
      const report = await runReproduction131(options)
      const rendered = `${JSON.stringify(report, null, 2)}\n`
      if (options.output !== undefined) {
        const outputPath = resolve(options.output)
        mkdirSync(dirname(outputPath), { recursive: true })
        writeFileSync(outputPath, rendered)
      }
      process.stdout.write(rendered)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}
