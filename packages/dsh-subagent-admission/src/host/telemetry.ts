import { randomUUID } from 'node:crypto'

import {
  MAX_HISTORY_EVENTS,
  SNAPSHOT_SCHEMA_VERSION,
  type AdmissionEvent,
  type AdmissionEventKind,
  type AdmissionLease,
  type AdmissionLimits,
  type AdmissionMode,
  type AdmissionOperation,
  type AdmissionSnapshot,
  type SnapshotWatchRequest,
} from '../types.js'

export interface TelemetryStatus {
  readonly mode: AdmissionMode
  readonly enforced: boolean
  readonly reason: string | null
}

export interface TelemetryLeaseInput {
  readonly permitId: string
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly rootSessionId: string
  readonly parentSessionId: string
  readonly expectedChildSessionId: string | null
  readonly childSessionId: string | null
  readonly admittedAt: number
  readonly phase: 'active' | 'draining'
  readonly mode?: AdmissionMode
}

export interface TelemetryRootLedgerSnapshot {
  readonly rootSessionId: string
  readonly admittedTotal: number
  readonly admittedChildrenByParent: Readonly<Record<string, number>>
}

export interface AdmissionTelemetryEventInput {
  readonly kind: AdmissionEventKind | 'bound'
  readonly time: number
  readonly requestId?: string | null
  readonly operation?: AdmissionOperation | null
  readonly rootId?: string | null
  readonly parentSessionId?: string | null
  readonly childSessionId?: string | null
  readonly code?: string | null
  readonly duplicate?: boolean
}

export interface AdmissionTelemetryOptions {
  readonly epoch?: string
  readonly limits: AdmissionLimits
  readonly readStatus: () => TelemetryStatus
  readonly readLeases: () => readonly TelemetryLeaseInput[]
  readonly readRootLedger: (
    rootId: string,
  ) => TelemetryRootLedgerSnapshot | undefined
  readonly resolveRoot?: (sessionId: string) => string | null
  readonly clock?: { now(): number }
}

interface SanitizedEvent {
  readonly kind: AdmissionEventKind | 'bound'
  readonly time: string
  readonly requestId: string | null
  readonly operation: AdmissionOperation | null
  readonly rootId: string | null
  readonly parentSessionId: string | null
  readonly childSessionId: string | null
  readonly code: string | null
  readonly duplicate: boolean
}

interface SnapshotInputs {
  readonly status: TelemetryStatus
  readonly leases: readonly SanitizedLease[]
  readonly readerFailed: boolean
}

interface SanitizedLease extends TelemetryLeaseInput {
  readonly mode: AdmissionMode
}

/**
 * Best-effort, read-only projection of authoritative admission state.
 *
 * The constructor accepts functions that return detached snapshots, never the
 * authority, ledger, or registry objects themselves. Events only advance this
 * process-local projection and wake full-snapshot watchers; they are never read
 * back into an admission decision.
 */
export class AdmissionTelemetry {
  readonly epoch: string

  private readonly limits: AdmissionLimits
  private readonly readStatus: () => TelemetryStatus
  private readonly readLeases: () => readonly TelemetryLeaseInput[]
  private readonly readRootLedger: (
    rootId: string,
  ) => TelemetryRootLedgerSnapshot | undefined
  private readonly resolveRoot: ((sessionId: string) => string | null) | undefined
  private readonly clock: { now(): number }
  private readonly history: AdmissionEvent[] = []
  private readonly sessionRoots = new Map<string, string>()
  private readonly changeWaiters = new Set<() => void>()
  private revisionValue = 0
  private droppedHistoryValue = 0
  private projectionReason: string | null = null

  constructor(options: AdmissionTelemetryOptions) {
    const epoch = options.epoch ?? randomUUID()
    if (epoch.length === 0) {
      throw new Error('telemetry epoch must not be empty')
    }
    this.epoch = epoch
    this.limits = Object.freeze({ ...options.limits })
    this.readStatus = options.readStatus
    this.readLeases = options.readLeases
    this.readRootLedger = options.readRootLedger
    this.resolveRoot = options.resolveRoot
    this.clock = options.clock ?? { now: Date.now }
  }

  get revision(): number {
    return this.revisionValue
  }

  record(input: AdmissionTelemetryEventInput): void {
    const event = this.scopeEvent(sanitizeEvent(input))
    this.rememberBindings(event)
    this.revisionValue += 1

    if (event.kind !== 'bound') {
      const projected: AdmissionEvent = Object.freeze({
        kind: event.duplicate ? 'protocol' : event.kind,
        time: event.time,
        requestId: event.requestId,
        operation: event.operation,
        rootId: event.rootId,
        parentSessionId: event.parentSessionId,
        code: event.duplicate ? 'DUPLICATE_RELEASE' : event.code,
      })
      this.history.push(projected)
      if (this.history.length > MAX_HISTORY_EVENTS) {
        this.history.shift()
        this.droppedHistoryValue += 1
      }
    }

    const waiters = [...this.changeWaiters]
    this.changeWaiters.clear()
    for (const resolve of waiters) {
      resolve()
    }
  }

  snapshot(sessionId: string): AdmissionSnapshot {
    const requestedSessionId = typeof sessionId === 'string' ? sessionId : ''
    const inputs = this.readSnapshotInputs()
    let readerFailed = inputs.readerFailed
    let requestedRootId: string | null = null

    if (requestedSessionId.length > 0) {
      try {
        requestedRootId = this.resolveRoot?.(requestedSessionId) ?? null
      } catch {
        readerFailed = true
      }
      requestedRootId ??=
        this.sessionRoots.get(requestedSessionId) ??
        inferRootFromLeases(requestedSessionId, inputs.leases)
    }

    let ledger: TelemetryRootLedgerSnapshot | undefined
    if (requestedRootId !== null) {
      try {
        const rawLedger = this.readRootLedger(requestedRootId)
        ledger = sanitizeLedger(rawLedger)
        if (
          rawLedger !== undefined &&
          (ledger === undefined || ledger.rootSessionId !== requestedRootId)
        ) {
          readerFailed = true
          ledger = undefined
        }
      } catch {
        readerFailed = true
      }
    } else if (requestedSessionId.length > 0) {
      try {
        const rawCandidate = this.readRootLedger(requestedSessionId)
        const candidate = sanitizeLedger(rawCandidate)
        if (rawCandidate !== undefined && candidate === undefined) {
          readerFailed = true
        }
        if (candidate?.rootSessionId === requestedSessionId) {
          requestedRootId = requestedSessionId
          ledger = candidate
        }
      } catch {
        readerFailed = true
      }
    }

    const status = readerFailed
      ? {
          mode: 'unavailable' as const,
          enforced: false,
          reason: 'telemetry-reader-unavailable',
        }
      : this.projectionReason !== null
        ? {
            mode: 'unavailable' as const,
            enforced: false,
            reason: this.projectionReason,
          }
      : inputs.status
    const scopedLeases = inputs.leases
      .filter((lease) => lease.rootSessionId === requestedRootId)
      .map((lease): AdmissionLease =>
        Object.freeze({
          childSessionId:
            lease.childSessionId ?? lease.expectedChildSessionId ?? null,
          parentSessionId: lease.parentSessionId,
          rootId: lease.rootSessionId,
          operation: lease.operation,
          mode: lease.mode,
          admittedAt: isoTime(lease.admittedAt),
          phase: lease.phase,
        }),
      )
    const scopedHistory = this.history.filter(
      (event) =>
        event.rootId === null ||
        (requestedRootId !== null && event.rootId === requestedRootId),
    )
    const rootActive = inputs.leases.filter(
      (lease) => lease.rootSessionId === requestedRootId,
    ).length
    const parentChildren =
      ledger?.admittedChildrenByParent[requestedSessionId] ?? 0

    return Object.freeze({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      time: isoTime(this.telemetryNow()),
      epoch: this.epoch,
      revision: this.revisionValue,
      requestedSessionId,
      requestedRootId,
      mode: status.mode,
      enforced: status.enforced,
      reason: status.reason,
      limits: this.limits,
      usage: Object.freeze({
        globalActive: inputs.leases.length,
        rootActive,
        rootAdmittedTotal: ledger?.admittedTotal ?? 0,
        parentChildren,
      }),
      leases: Object.freeze(scopedLeases),
      history: Object.freeze(scopedHistory),
      droppedHistory: this.droppedHistoryValue,
    })
  }

  async watch(
    request: SnapshotWatchRequest,
    signal: AbortSignal,
  ): Promise<AdmissionSnapshot> {
    if (
      request.epoch !== this.epoch ||
      request.revision !== this.revisionValue
    ) {
      return this.snapshot(request.sessionId)
    }
    await this.changedOrTimeout(request.timeoutMs, signal)
    return this.snapshot(request.sessionId)
  }

  private readSnapshotInputs(): SnapshotInputs {
    let readerFailed = false
    let status: TelemetryStatus = {
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-reader-unavailable',
    }
    let leases: readonly SanitizedLease[] = []
    try {
      status = sanitizeStatus(this.readStatus())
    } catch {
      readerFailed = true
    }
    try {
      const rawLeases = this.readLeases()
      const sanitizedLeases = rawLeases
        .map((lease) => sanitizeLease(lease, status.mode))
        .filter((lease): lease is SanitizedLease => lease !== undefined)
      if (sanitizedLeases.length !== rawLeases.length) {
        readerFailed = true
      }
      leases = Object.freeze(sanitizedLeases)
    } catch {
      readerFailed = true
    }
    return { status, leases, readerFailed }
  }

  private rememberBindings(event: SanitizedEvent): void {
    if (event.rootId === null) {
      return
    }
    this.rememberSessionRoot(event.rootId, event.rootId)
    if (event.parentSessionId !== null) {
      this.rememberSessionRoot(event.parentSessionId, event.rootId)
    }
    if (
      event.childSessionId !== null &&
      event.kind !== 'denied'
    ) {
      this.rememberSessionRoot(event.childSessionId, event.rootId)
    }
  }

  private rememberSessionRoot(sessionId: string, rootId: string): void {
    const existing = this.sessionRoots.get(sessionId)
    if (existing !== undefined && existing !== rootId) {
      this.projectionReason = 'telemetry-binding-conflict'
      return
    }
    this.sessionRoots.set(sessionId, rootId)
  }

  private scopeEvent(event: SanitizedEvent): SanitizedEvent {
    if (event.rootId !== null) {
      return event
    }
    const inferredRootId =
      (event.parentSessionId === null
        ? undefined
        : this.sessionRoots.get(event.parentSessionId)) ??
      (event.childSessionId === null
        ? undefined
        : this.sessionRoots.get(event.childSessionId))
    if (inferredRootId !== undefined) {
      return Object.freeze({ ...event, rootId: inferredRootId })
    }
    return Object.freeze({
      ...event,
      requestId: null,
      parentSessionId: null,
      childSessionId: null,
    })
  }

  private telemetryNow(): number {
    try {
      const now = this.clock.now()
      return Number.isSafeInteger(now) && now >= 0 ? now : 0
    } catch {
      return 0
    }
  }

  private changedOrTimeout(
    rawTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new SnapshotWatchAbortError())
    }
    const timeoutMs = clampTimeout(rawTimeoutMs)
    if (timeoutMs === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        this.changeWaiters.delete(onChange)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = (outcome: 'change' | 'timeout' | 'abort'): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (outcome === 'abort') {
          reject(new SnapshotWatchAbortError())
        } else {
          resolve()
        }
      }
      const onChange = (): void => finish('change')
      const onAbort = (): void => finish('abort')

      this.changeWaiters.add(onChange)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish('timeout'), timeoutMs)
      if (signal.aborted) {
        finish('abort')
      }
    })
  }
}

class SnapshotWatchAbortError extends Error {
  constructor() {
    super('Snapshot watch aborted')
    Object.defineProperty(this, 'name', {
      value: 'AbortError',
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
}

function sanitizeEvent(input: AdmissionTelemetryEventInput): SanitizedEvent {
  const kind = isTelemetryEventKind(input.kind) ? input.kind : 'protocol'
  return Object.freeze({
    kind,
    time: isoTime(input.time),
    requestId: nullableId(input.requestId),
    operation: isAdmissionOperation(input.operation) ? input.operation : null,
    rootId: nullableId(input.rootId),
    parentSessionId: nullableId(input.parentSessionId),
    childSessionId: nullableId(input.childSessionId),
    code: safeCode(input.code),
    duplicate: input.duplicate === true,
  })
}

function sanitizeStatus(status: TelemetryStatus): TelemetryStatus {
  const coherentEnforcement =
    (status.mode === 'strict' && status.enforced === true) ||
    ((status.mode === 'audit' || status.mode === 'unavailable') &&
      status.enforced === false) ||
    (status.mode === 'draining' && typeof status.enforced === 'boolean')
  if (!isAdmissionMode(status.mode) || !coherentEnforcement) {
    return Object.freeze({
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-reader-unavailable',
    })
  }
  return Object.freeze({
    mode: status.mode,
    enforced: status.enforced === true,
    reason: safeCode(status.reason),
  })
}

function sanitizeLease(
  lease: TelemetryLeaseInput,
  fallbackMode: AdmissionMode,
): SanitizedLease | undefined {
  if (
    !isAdmissionOperation(lease.operation) ||
    lease.permitId.length === 0 ||
    lease.requestId.length === 0 ||
    lease.rootSessionId.length === 0 ||
    lease.parentSessionId.length === 0 ||
    !Number.isSafeInteger(lease.admittedAt) ||
    lease.admittedAt < 0 ||
    (lease.phase !== 'active' && lease.phase !== 'draining')
  ) {
    return undefined
  }
  return Object.freeze({
    permitId: lease.permitId,
    requestId: lease.requestId,
    operation: lease.operation,
    rootSessionId: lease.rootSessionId,
    parentSessionId: lease.parentSessionId,
    expectedChildSessionId: nullableId(lease.expectedChildSessionId),
    childSessionId: nullableId(lease.childSessionId),
    admittedAt: lease.admittedAt,
    phase: lease.phase,
    mode: isAdmissionMode(lease.mode) ? lease.mode : fallbackMode,
  })
}

function sanitizeLedger(
  ledger: TelemetryRootLedgerSnapshot | undefined,
): TelemetryRootLedgerSnapshot | undefined {
  if (
    ledger === undefined ||
    ledger.rootSessionId.length === 0 ||
    !Number.isSafeInteger(ledger.admittedTotal) ||
    ledger.admittedTotal < 0
  ) {
    return undefined
  }
  const counts: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >
  for (const [parentId, count] of Object.entries(
    ledger.admittedChildrenByParent,
  )) {
    if (
      parentId.length > 0 &&
      Number.isSafeInteger(count) &&
      count >= 0
    ) {
      counts[parentId] = count
    }
  }
  return Object.freeze({
    rootSessionId: ledger.rootSessionId,
    admittedTotal: ledger.admittedTotal,
    admittedChildrenByParent: Object.freeze(counts),
  })
}

function inferRootFromLeases(
  sessionId: string,
  leases: readonly SanitizedLease[],
): string | null {
  for (const lease of leases) {
    if (
      lease.rootSessionId === sessionId ||
      lease.parentSessionId === sessionId ||
      lease.childSessionId === sessionId ||
      lease.expectedChildSessionId === sessionId
    ) {
      return lease.rootSessionId
    }
  }
  return null
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return 0
  }
  return Math.min(30_000, Math.max(0, Math.floor(timeoutMs)))
}

function isoTime(value: number): string {
  return new Date(
    Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
      ? value
      : 0,
  ).toISOString()
}

function nullableId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : null
}

function isAdmissionOperation(value: unknown): value is AdmissionOperation {
  return (
    value === 'new-one-shot' ||
    value === 'new-continuable' ||
    value === 'cold-resume'
  )
}

function isAdmissionMode(value: unknown): value is AdmissionMode {
  return (
    value === 'strict' ||
    value === 'audit' ||
    value === 'unavailable' ||
    value === 'draining'
  )
}

function isTelemetryEventKind(
  value: unknown,
): value is AdmissionEventKind | 'bound' {
  return (
    value === 'accepted' ||
    value === 'bound' ||
    value === 'denied' ||
    value === 'released' ||
    value === 'failed-start' ||
    value === 'protocol' ||
    value === 'bootstrap'
  )
}
