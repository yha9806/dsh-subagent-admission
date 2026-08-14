import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import type { Context } from '@deepseek-ai/cordis'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type {
  AdmissionSnapshot,
  SnapshotGetRequest,
  SnapshotWatchRequest,
} from '../types.js'
import type {
  AdmissionAuthority,
  AdmissionLedger,
} from './authority.js'
import { AdmissionAuthority as StrictAdmissionAuthority } from './authority.js'
import {
  embeddedCompatibilityBaseline,
  selectAdmissionMode,
  type CompatibilityBaseline,
  type CompatibilityRuntime,
} from './compatibility.js'
import {
  resolveConfig,
  type ConfigInput,
} from './config.js'
import { ActiveLeaseRegistry } from './leases.js'
import { RootLedgerStore } from './ledger.js'
import type { RootLedgerRow } from './ledger-spec.js'
import { ProcessOwnershipGuard } from './process-guard.js'
import {
  DurableRootResolver,
  type RootResolution,
  type SessionHeaderReader,
} from './root-resolver.js'
import type { SubagentAdmissionPolicyV1 } from './seam-v1.js'
import {
  AdmissionTelemetry,
  type TelemetryStatus,
} from './telemetry.js'

const require = createRequire(import.meta.url)

interface HostSessionHeader {
  readonly id: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

interface HostSession {
  readonly id: string
  readonly header: HostSessionHeader
}

interface HostSessionStore {
  get(id: string): HostSession | undefined
  list(): HostSession[]
}

interface HostSessionPersistence {
  list(signal?: AbortSignal): Promise<HostSessionHeader[]>
  inspect(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly meta: HostSessionHeader } | undefined>
}

interface HostSubagentRuntime {
  readonly admissionProtocolVersion?: number
  readonly registerAdmissionPolicy?: (
    policy: SubagentAdmissionPolicyV1,
  ) => () => void
}

interface OwnedGuard {
  assertHeld(): Promise<void>
  release(): Promise<void>
}

interface OwnedLedger extends AdmissionLedger {
  read(rootId: string): Promise<Readonly<RootLedgerRow> | undefined>
  close(): Promise<void>
}

export interface HostServiceCompositionOptions {
  readonly baseline?: CompatibilityBaseline
  readonly runtimePackageVersion?: string
  readonly acquireGuard?: (path: string) => Promise<OwnedGuard>
  readonly openLedger?: (
    storageDomain: Pick<DomainFacility, 'open'>,
  ) => Promise<OwnedLedger>
  readonly epoch?: string
  readonly clock?: { now(): number }
}

/**
 * Compose one honest Host service from the currently mounted DSH services.
 * Operational Strict failures are converted into an Unavailable snapshot;
 * invalid user configuration still rejects at the plugin boundary.
 */
export async function createSubagentAdmissionService(
  ctx: Context,
  input: ConfigInput = {},
  options: HostServiceCompositionOptions = {},
): Promise<SubagentAdmissionService> {
  const config = resolveConfig(input)
  const limits = Object.freeze({
    globalActive: config.globalActive,
    perRootActive: config.perRootActive,
    perRootAdmittedTotal: config.perRootAdmittedTotal,
    perParentChildren: config.perParentChildren,
  })
  const runtime = serviceOf<HostSubagentRuntime>(ctx, 'subagents')
  const sessions = serviceOf<HostSessionStore>(ctx, 'sessions')
  const persistence = serviceOf<HostSessionPersistence>(
    ctx,
    'sessionPersistence',
  )
  const storageDomain = serviceOf<Pick<DomainFacility, 'open'>>(
    ctx,
    'storageDomain',
  )
  const runtimeFacts = compatibilityRuntime(
    runtime,
    options.runtimePackageVersion ?? installedSubagentPackageVersion(),
  )
  const baseline = options.baseline ?? embeddedCompatibilityBaseline()
  const clock = options.clock ?? { now: Date.now }
  const epoch = options.epoch ?? randomUUID()

  if (config.mode === 'audit') {
    return createAuditService(ctx, {
      limits,
      sessions,
      epoch,
      clock,
    })
  }

  const preflight = selectAdmissionMode({
    configured: 'strict',
    runtime: runtimeFacts,
    baseline,
    storageDomainAvailable: storageDomain !== undefined,
    bootstrap: { safe: true, reason: null },
    ownershipGuardHeld: true,
  })
  if (preflight.mode !== 'strict') {
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      preflight.reason ?? 'strict-unavailable',
    )
  }
  if (
    runtime === undefined ||
    sessions === undefined ||
    persistence === undefined ||
    storageDomain === undefined
  ) {
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      'host-dependencies-unavailable',
    )
  }

  const acquireGuard =
    options.acquireGuard ?? ProcessOwnershipGuard.acquire
  const openLedger =
    options.openLedger ??
    ((domain: Pick<DomainFacility, 'open'>): Promise<OwnedLedger> =>
      RootLedgerStore.open(domain))

  let guard: OwnedGuard
  try {
    guard = await acquireGuard(config.ownershipPath)
    await guard.assertHeld()
  } catch {
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      'ownership-guard-unavailable',
    )
  }

  let ledger: OwnedLedger
  try {
    ledger = await openLedger(storageDomain)
  } catch {
    await guard.release().catch(() => undefined)
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      'admission-state-io',
    )
  }

  let bootstrap: BootstrapResult
  try {
    bootstrap = await bootstrapSessions(sessions, persistence)
  } catch (error) {
    await cleanupStrictResources(ledger, guard)
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      bootstrapReason(error),
    )
  }

  const ledgerCache = new Map<string, Readonly<RootLedgerRow>>()
  try {
    for (const rootId of bootstrap.rootIds) {
      const row = await ledger.read(rootId)
      if (row !== undefined) {
        ledgerCache.set(rootId, row)
      }
    }
    assertNoLiveSubagents(sessions)
  } catch {
    await cleanupStrictResources(ledger, guard)
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      'unsafe-bootstrap',
    )
  }

  const leases = new ActiveLeaseRegistry()
  const status = mutableStatus({ mode: 'strict', enforced: true, reason: null })
  const telemetry = new AdmissionTelemetry({
    epoch,
    limits,
    readStatus: status.read,
    readLeases: (): ReturnType<ActiveLeaseRegistry['snapshot']> =>
      leases.snapshot(),
    readRootLedger: (rootId) => ledgerCache.get(rootId),
    resolveRoot: (sessionId) => bootstrap.roots.get(sessionId) ?? null,
    clock,
  })
  const authoritativeLedger: AdmissionLedger = {
    reserveNew: async (reservation, assertActiveCapacity) => {
      const row = await ledger.reserveNew(
        reservation,
        assertActiveCapacity,
      ) as RootLedgerRow
      ledgerCache.set(row.rootSessionId, row)
      return row
    },
  }
  const authority = new StrictAdmissionAuthority({
    limits,
    policyEpoch: epoch,
    roots: bootstrap.resolver,
    ledger: authoritativeLedger,
    guard,
    leases,
    clock,
    onEvent: (event): void => {
      telemetry.record(event)
    },
  })

  let unregisterPolicy: (() => void) | undefined
  try {
    assertNoLiveSubagents(sessions)
    unregisterPolicy = runtime.registerAdmissionPolicy?.(authority)
    if (typeof unregisterPolicy !== 'function') {
      throw new Error('policy registration returned no disposer')
    }
  } catch {
    authority.closeAdmission()
    await authority.drain().catch(() => undefined)
    await cleanupStrictResources(ledger, guard)
    return createUnavailableService(
      ctx,
      limits,
      epoch,
      clock,
      'policy-registration-failed',
    )
  }

  telemetry.record({
    kind: 'bootstrap',
    time: safeNow(clock),
    code: 'strict-bootstrap-complete',
  })
  return new SubagentAdmissionService(ctx, {
    telemetry,
    authority,
    unregisterPolicy,
    beginDrain: (): void => {
      status.set({ mode: 'draining', enforced: true, reason: 'disposing' })
      telemetry.record({
        kind: 'protocol',
        time: safeNow(clock),
        code: 'draining',
      })
    },
    closeLedger: (): Promise<void> => ledger.close(),
    releaseGuard: (): Promise<void> => guard.release(),
  })
}

export interface SnapshotTelemetry {
  snapshot(sessionId: string): AdmissionSnapshot
  watch(
    request: SnapshotWatchRequest,
    signal: AbortSignal,
  ): Promise<AdmissionSnapshot>
}

/** Already-composed ownership resources held by the public Host service. */
export interface SubagentAdmissionServiceResources {
  readonly telemetry: SnapshotTelemetry
  readonly authority?: Pick<AdmissionAuthority, 'closeAdmission' | 'drain'>
  readonly beginDrain?: () => void
  readonly unregisterPolicy?: () => void
  readonly stopAudit?: () => void
  readonly closeLedger?: () => Promise<void>
  readonly releaseGuard?: () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagentAdmission: SubagentAdmissionService
  }
}

/**
 * Read-only Snapshot Remote plus the teardown owner for the admission kernel.
 *
 * Disposal closes the authority synchronously before awaiting any outstanding
 * permit. The policy registration is then tombstoned while existing permit
 * closures remain usable. Storage and process ownership are released only
 * after the authority has drained to zero active leases.
 */
export class SubagentAdmissionService extends TypertRemoteService {
  private readonly telemetry: SnapshotTelemetry
  private readonly authority:
    | Pick<AdmissionAuthority, 'closeAdmission' | 'drain'>
    | undefined
  private readonly unregisterPolicy: (() => void) | undefined
  private readonly beginDrain: (() => void) | undefined
  private readonly stopAudit: (() => void) | undefined
  private readonly closeLedger: (() => Promise<void>) | undefined
  private readonly releaseGuard: (() => Promise<void>) | undefined
  private disposePromise: Promise<void> | undefined

  constructor(
    ctx: Context,
    resources: SubagentAdmissionServiceResources,
  ) {
    super(ctx, 'subagentAdmission', { namespace: 'snapshot' })
    this.telemetry = resources.telemetry
    this.authority = resources.authority
    this.beginDrain = resources.beginDrain
    this.unregisterPolicy = resources.unregisterPolicy
    this.stopAudit = resources.stopAudit
    this.closeLedger = resources.closeLedger
    this.releaseGuard = resources.releaseGuard
  }

  @Remote('get')
  get(request: SnapshotGetRequest): Promise<AdmissionSnapshot> {
    return Promise.resolve(this.telemetry.snapshot(request.sessionId))
  }

  @Remote('watch')
  watch(
    request: SnapshotWatchRequest,
    signal: AbortSignal,
  ): Promise<AdmissionSnapshot> {
    return this.telemetry.watch(request, signal)
  }

  /** Synchronous convenience for Host diagnostics and tests. */
  currentSnapshot(sessionId: string): AdmissionSnapshot {
    return this.telemetry.snapshot(sessionId)
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise
    }

    // These are the admission tombstones. They deliberately happen before the
    // first await, so a concurrent caller cannot slip behind teardown.
    this.authority?.closeAdmission()
    const immediateErrors: unknown[] = []
    runDisposer(this.beginDrain, immediateErrors)
    runDisposer(this.unregisterPolicy, immediateErrors)
    runDisposer(this.stopAudit, immediateErrors)

    this.disposePromise = this.finishDisposal(immediateErrors)
    return this.disposePromise
  }

  private async finishDisposal(errors: unknown[]): Promise<void> {
    await settleStep(
      this.authority === undefined
        ? undefined
        : (): Promise<void> => this.authority?.drain() ?? Promise.resolve(),
      errors,
    )
    await settleStep(this.closeLedger, errors)
    await settleStep(this.releaseGuard, errors)
    if (errors.length === 1) {
      throw errors[0]
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'subagent admission disposal failed')
    }
  }
}

interface CommonTelemetryOptions {
  readonly limits: {
    readonly globalActive: number
    readonly perRootActive: number
    readonly perRootAdmittedTotal: number
    readonly perParentChildren: number
  }
  readonly epoch: string
  readonly clock: { now(): number }
}

interface AuditServiceOptions extends CommonTelemetryOptions {
  readonly sessions: HostSessionStore | undefined
}

function createAuditService(
  ctx: Context,
  options: AuditServiceOptions,
): SubagentAdmissionService {
  const status = mutableStatus({
    mode: 'audit',
    enforced: false,
    reason: 'audit-observation-only',
  })
  const telemetry = new AdmissionTelemetry({
    epoch: options.epoch,
    limits: options.limits,
    readStatus: status.read,
    readLeases: () => Object.freeze([]),
    readRootLedger: () => undefined,
    resolveRoot: (sessionId) =>
      auditLineage(options.sessions, sessionId)?.rootId ?? null,
    clock: options.clock,
  })
  let stopAudit: (() => void) | undefined
  try {
    stopAudit = observeAuditLifecycle(
      ctx,
      options.sessions,
      telemetry,
      options.clock,
    )
  } catch {
    status.set({
      mode: 'unavailable',
      enforced: false,
      reason: 'audit-observer-unavailable',
    })
  }
  telemetry.record({
    kind: 'bootstrap',
    time: safeNow(options.clock),
    code: status.read().reason,
  })
  return new SubagentAdmissionService(ctx, {
    telemetry,
    ...(stopAudit === undefined ? {} : { stopAudit }),
    beginDrain: (): void => {
      status.set({ mode: 'draining', enforced: false, reason: 'disposing' })
      telemetry.record({
        kind: 'protocol',
        time: safeNow(options.clock),
        code: 'draining',
      })
    },
  })
}

function createUnavailableService(
  ctx: Context,
  limits: CommonTelemetryOptions['limits'],
  epoch: string,
  clock: { now(): number },
  reason: string,
): SubagentAdmissionService {
  const status = mutableStatus({
    mode: 'unavailable',
    enforced: false,
    reason,
  })
  const telemetry = new AdmissionTelemetry({
    epoch,
    limits,
    readStatus: status.read,
    readLeases: () => Object.freeze([]),
    readRootLedger: () => undefined,
    clock,
  })
  telemetry.record({
    kind: 'protocol',
    time: safeNow(clock),
    code: reason,
  })
  return new SubagentAdmissionService(ctx, { telemetry })
}

function mutableStatus(initial: TelemetryStatus): {
  readonly read: () => TelemetryStatus
  readonly set: (next: TelemetryStatus) => void
} {
  let current = Object.freeze({ ...initial })
  return Object.freeze({
    read: (): TelemetryStatus => current,
    set: (next: TelemetryStatus): void => {
      current = Object.freeze({ ...next })
    },
  })
}

interface AuditObservation {
  readonly childId: string
  readonly parentId: string | null
  readonly rootId: string | null
}

function observeAuditLifecycle(
  ctx: Context,
  sessions: HostSessionStore | undefined,
  telemetry: AdmissionTelemetry,
  clock: { now(): number },
): () => void {
  const active = new Map<string, AuditObservation>()
  const on = (ctx as unknown as {
    on(
      name: string,
      listener: (info: unknown) => void,
    ): () => unknown
  }).on
  if (typeof on !== 'function') {
    throw new Error('Cordis event observer unavailable')
  }
  const stopStart = on.call(ctx, 'subagent/start', (raw): void => {
    const info = lifecycleIdentity(raw)
    if (info === undefined) {
      telemetry.record({
        kind: 'protocol',
        time: safeNow(clock),
        code: 'audit-invalid-start',
      })
      return
    }
    const lineage = auditLineage(sessions, info.childId)
    const observation = Object.freeze({
      childId: info.childId,
      parentId: lineage?.parentId ?? null,
      rootId: lineage?.rootId ?? null,
    })
    active.set(info.runId, observation)
    telemetry.record({
      kind: 'accepted',
      time: safeNow(clock),
      requestId: null,
      operation: null,
      rootId: observation.rootId,
      parentSessionId: observation.parentId,
      childSessionId: observation.childId,
      code: null,
    })
  })
  const stopEnd = on.call(ctx, 'subagent/end', (raw): void => {
    const info = lifecycleIdentity(raw)
    if (info === undefined) {
      telemetry.record({
        kind: 'protocol',
        time: safeNow(clock),
        code: 'audit-invalid-end',
      })
      return
    }
    const observation = active.get(info.runId)
    active.delete(info.runId)
    telemetry.record({
      kind: observation === undefined ? 'protocol' : 'released',
      time: safeNow(clock),
      requestId: null,
      operation: null,
      rootId: observation?.rootId ?? null,
      parentSessionId: observation?.parentId ?? null,
      childSessionId: observation?.childId ?? info.childId,
      code: observation === undefined ? 'audit-unpaired-end' : null,
    })
  })
  return (): void => {
    stopEnd()
    stopStart()
    active.clear()
  }
}

function lifecycleIdentity(
  value: unknown,
): { readonly runId: string; readonly childId: string } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.id === 'string' &&
    value.id.length > 0
    ? Object.freeze({ runId: value.runId, childId: value.id })
    : undefined
}

function auditLineage(
  sessions: HostSessionStore | undefined,
  childId: string,
): { readonly parentId: string | null; readonly rootId: string } | undefined {
  if (sessions === undefined || childId.length === 0) {
    return undefined
  }
  try {
    const child = sessions.get(childId)
    if (child === undefined || child.header.id !== childId) {
      return undefined
    }
    const parentId = normalizedParent(child.header)
    const seen = new Set<string>()
    let current = child
    while (true) {
      if (seen.has(current.id)) {
        return undefined
      }
      seen.add(current.id)
      const parent = normalizedParent(current.header)
      if (parent === undefined) {
        return Object.freeze({ parentId: parentId ?? null, rootId: current.id })
      }
      const next = sessions.get(parent)
      if (next === undefined || next.header.id !== parent) {
        return undefined
      }
      current = next
    }
  } catch {
    return undefined
  }
}

interface BootstrapResult {
  readonly resolver: RootResolution
  readonly roots: ReadonlyMap<string, string>
  readonly rootIds: readonly string[]
}

class BootstrapFailure extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

class BootstrapHeaders implements SessionHeaderReader {
  private readonly sessions: HostSessionStore
  private readonly persistence: HostSessionPersistence
  private readonly headers = new Map<string, HostSessionHeader>()

  constructor(
    sessions: HostSessionStore,
    persistence: HostSessionPersistence,
  ) {
    this.sessions = sessions
    this.persistence = persistence
  }

  add(raw: HostSessionHeader): HostSessionHeader {
    const header = normalizedHeader(raw)
    const current = this.headers.get(header.id)
    if (
      current !== undefined &&
      normalizedParent(current) !== normalizedParent(header)
    ) {
      throw new BootstrapFailure('bootstrap-header-conflict')
    }
    this.headers.set(header.id, header)
    return header
  }

  values(): readonly HostSessionHeader[] {
    return Object.freeze([...this.headers.values()])
  }

  async inspect(
    sessionId: string,
  ): Promise<
    { readonly id: string; readonly parentSession?: string } | undefined
  > {
    let live: HostSession | undefined
    try {
      live = this.sessions.get(sessionId)
    } catch {
      throw new BootstrapFailure('bootstrap-session-read-unavailable')
    }
    if (live !== undefined) {
      const header = this.add(live.header)
      if (live.id !== sessionId || header.id !== sessionId) {
        throw new BootstrapFailure('bootstrap-header-conflict')
      }
      return resolverHeader(header)
    }
    const cached = this.headers.get(sessionId)
    if (cached !== undefined) {
      return resolverHeader(cached)
    }
    let inspected: { readonly meta: HostSessionHeader } | undefined
    try {
      inspected = await this.persistence.inspect(sessionId)
    } catch {
      throw new BootstrapFailure('bootstrap-lineage-incomplete')
    }
    if (inspected === undefined) {
      return undefined
    }
    const header = this.add(inspected.meta)
    return header.id === sessionId ? resolverHeader(header) : undefined
  }
}

async function bootstrapSessions(
  sessions: HostSessionStore,
  persistence: HostSessionPersistence,
): Promise<BootstrapResult> {
  const catalog = new BootstrapHeaders(sessions, persistence)
  let persisted: HostSessionHeader[]
  let live: HostSession[]
  try {
    ;[persisted, live] = await Promise.all([
      persistence.list(),
      Promise.resolve(sessions.list()),
    ])
  } catch {
    throw new BootstrapFailure('bootstrap-session-list-unavailable')
  }
  if (!Array.isArray(persisted) || !Array.isArray(live)) {
    throw new BootstrapFailure('bootstrap-session-list-unavailable')
  }
  for (const header of persisted) {
    catalog.add(header)
  }
  for (const session of live) {
    if (!isRecord(session) || session.id !== session.header?.id) {
      throw new BootstrapFailure('bootstrap-header-conflict')
    }
    catalog.add(session.header)
  }
  assertNoLiveSubagents(sessions)

  const resolver = new DurableRootResolver(catalog)
  const roots = new Map<string, string>()
  const rootIds = new Set<string>()
  try {
    for (const header of catalog.values()) {
      const resolved = await resolver.resolve(header.id)
      rootIds.add(resolved.rootSessionId)
      for (const sessionId of resolved.lineage) {
        const current = roots.get(sessionId)
        if (current !== undefined && current !== resolved.rootSessionId) {
          throw new BootstrapFailure('bootstrap-root-conflict')
        }
        roots.set(sessionId, resolved.rootSessionId)
      }
    }
  } catch (error) {
    if (error instanceof BootstrapFailure) {
      throw error
    }
    throw new BootstrapFailure('bootstrap-lineage-incomplete')
  }
  return Object.freeze({
    resolver,
    roots,
    rootIds: Object.freeze([...rootIds].sort()),
  })
}

function assertNoLiveSubagents(sessions: HostSessionStore): void {
  let live: HostSession[]
  try {
    live = sessions.list()
  } catch {
    throw new BootstrapFailure('bootstrap-live-state-unavailable')
  }
  if (!Array.isArray(live)) {
    throw new BootstrapFailure('bootstrap-live-state-unavailable')
  }
  for (const session of live) {
    const header = normalizedHeader(session.header)
    if (session.id !== header.id) {
      throw new BootstrapFailure('bootstrap-header-conflict')
    }
    if (header.origin === 'subagent') {
      throw new BootstrapFailure('bootstrap-live-subagent-present')
    }
  }
}

function normalizedHeader(raw: HostSessionHeader): HostSessionHeader {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new BootstrapFailure('bootstrap-header-invalid')
  }
  const parent = normalizedParent(raw)
  if (parent === raw.id) {
    throw new BootstrapFailure('bootstrap-lineage-incomplete')
  }
  return Object.freeze({
    id: raw.id,
    ...(parent === undefined ? {} : { parentSession: parent }),
    ...(raw.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
  })
}

function normalizedParent(
  header: HostSessionHeader,
): string | undefined {
  if (header.parentSession === undefined) {
    return undefined
  }
  if (
    typeof header.parentSession !== 'string' ||
    header.parentSession.length === 0
  ) {
    throw new BootstrapFailure('bootstrap-header-invalid')
  }
  return header.parentSession
}

function resolverHeader(
  header: HostSessionHeader,
): { readonly id: string; readonly parentSession?: string } {
  const parent = normalizedParent(header)
  return Object.freeze({
    id: header.id,
    ...(parent === undefined ? {} : { parentSession: parent }),
  })
}

function compatibilityRuntime(
  runtime: HostSubagentRuntime | undefined,
  packageVersion: string,
): CompatibilityRuntime {
  const protocol = runtime?.admissionProtocolVersion
  const register = runtime?.registerAdmissionPolicy
  return Object.freeze({
    packageVersion,
    ...(protocol === undefined ? {} : { admissionProtocolVersion: protocol }),
    ...(typeof register !== 'function'
      ? {}
      : {
          registerAdmissionPolicy: (
            policy: SubagentAdmissionPolicyV1,
          ): (() => void) => register.call(runtime, policy),
        }),
  })
}

function installedSubagentPackageVersion(): string {
  try {
    const manifest = require('@deepseek-ai/dsh-subagent/package.json') as unknown
    return isRecord(manifest) && typeof manifest.version === 'string'
      ? manifest.version
      : ''
  } catch {
    return ''
  }
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name, false) as T | undefined
  } catch {
    return undefined
  }
}

async function cleanupStrictResources(
  ledger: OwnedLedger,
  guard: OwnedGuard,
): Promise<void> {
  await ledger.close().catch(() => undefined)
  await guard.release().catch(() => undefined)
}

function bootstrapReason(error: unknown): string {
  return error instanceof BootstrapFailure ? error.reason : 'unsafe-bootstrap'
}

function safeNow(clock: { now(): number }): number {
  try {
    const now = clock.now()
    return Number.isSafeInteger(now) && now >= 0 ? now : 0
  } catch {
    return 0
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runDisposer(
  disposer: (() => void) | undefined,
  errors: unknown[],
): void {
  if (disposer === undefined) {
    return
  }
  try {
    disposer()
  } catch (error) {
    errors.push(error)
  }
}

async function settleStep(
  step: (() => Promise<void>) | undefined,
  errors: unknown[],
): Promise<void> {
  if (step === undefined) {
    return
  }
  try {
    await step()
  } catch (error) {
    errors.push(error)
  }
}
