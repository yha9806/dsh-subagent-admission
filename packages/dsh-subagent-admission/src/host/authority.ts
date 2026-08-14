import type { AdmissionLimits, AdmissionOperation } from '../types.js'

import {
  ADMISSION_ERROR_CODES,
  createAdmissionDenied,
  type AdmissionDenied,
  type AdmissionErrorCode,
} from './errors.js'
import type { ReserveNewInput } from './ledger.js'
import {
  ActiveLeaseRegistry,
  type ActiveLease,
} from './leases.js'
import type { ProcessOwnershipGuard } from './process-guard.js'
import type { RootResolution } from './root-resolver.js'
import type {
  SubagentAdmissionPermitV1,
  SubagentAdmissionPolicyV1,
  SubagentAdmissionRequestV1,
} from './seam-v1.js'

export type AdmissionReleaseReason = Parameters<
  SubagentAdmissionPermitV1['release']
>[0]

export interface AdmissionClock {
  now(): number
}

export interface AdmissionLedger {
  reserveNew(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<unknown>
}

export interface AdmissionAuthorityEvent {
  readonly kind: 'accepted' | 'denied' | 'released' | 'failed-start'
  readonly time: number
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly rootId: string
  readonly parentSessionId: string
  readonly childSessionId: string | null
  readonly code: AdmissionErrorCode | null
  readonly reason: AdmissionReleaseReason | null
  readonly duplicate: boolean
}

export interface AdmissionAuthorityOptions {
  readonly limits: AdmissionLimits
  readonly policyEpoch: string
  readonly roots: RootResolution
  readonly ledger: AdmissionLedger
  readonly guard: Pick<ProcessOwnershipGuard, 'assertHeld'>
  readonly leases?: ActiveLeaseRegistry
  readonly clock?: AdmissionClock
  readonly onEvent?: (event: AdmissionAuthorityEvent) => void
  readonly onInternalDiagnostic?: (diagnostic: string) => void
}

export class AdmissionAuthorityError extends Error implements AdmissionDenied {
  readonly code: AdmissionErrorCode
  readonly operation: AdmissionOperation
  readonly rootId: string
  readonly parentId: string | null
  readonly observedValue: number
  readonly limit: number
  readonly policyEpoch: string
  readonly requestId: string

  constructor(denial: AdmissionDenied) {
    super(`Admission denied: ${denial.code}`)
    Object.defineProperty(this, 'name', {
      value: 'AdmissionAuthorityError',
      enumerable: false,
      writable: true,
      configurable: true,
    })
    this.code = denial.code
    this.operation = denial.operation
    this.rootId = denial.rootId
    this.parentId = denial.parentId
    this.observedValue = denial.observedValue
    this.limit = denial.limit
    this.policyEpoch = denial.policyEpoch
    this.requestId = denial.requestId
    Object.freeze(this)
  }
}

class SerialSection {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      (): void => {},
      (): void => {},
    )
    return result
  }

  idle(): Promise<void> {
    return this.tail
  }
}

class AdmissionPermit implements SubagentAdmissionPermitV1 {
  private readonly bind: (binding: {
    readonly childSessionId: string
    readonly localParentSessionId?: string
  }) => void
  private readonly releaseOnce: (reason: AdmissionReleaseReason) => Promise<void>
  private readonly recordDuplicate: (reason: AdmissionReleaseReason) => void
  private readonly rejectBinding: () => AdmissionAuthorityError
  private releaseStarted = false
  private releasePromise: Promise<void> | undefined

  constructor(callbacks: {
    readonly bind: (binding: {
      readonly childSessionId: string
      readonly localParentSessionId?: string
    }) => void
    readonly release: (reason: AdmissionReleaseReason) => Promise<void>
    readonly recordDuplicate: (reason: AdmissionReleaseReason) => void
    readonly rejectBinding: () => AdmissionAuthorityError
  }) {
    this.bind = callbacks.bind
    this.releaseOnce = callbacks.release
    this.recordDuplicate = callbacks.recordDuplicate
    this.rejectBinding = callbacks.rejectBinding
  }

  bindChild(binding: {
    readonly childSessionId: string
    readonly localParentSessionId?: string
  }): void {
    if (this.releaseStarted) {
      throw this.rejectBinding()
    }
    this.bind(binding)
  }

  release(reason: AdmissionReleaseReason): Promise<void> {
    if (this.releasePromise !== undefined) {
      return this.releasePromise.then(() => {
        this.recordDuplicate(reason)
      })
    }
    this.releaseStarted = true
    this.releasePromise = this.releaseOnce(reason)
    return this.releasePromise
  }
}

/**
 * The single Strict-mode admission authority.
 *
 * Prepares and releases share one serial section. The ledger callback performs
 * root-active then global-active checks immediately before its one durable
 * write; lease insertion follows without I/O or caller callbacks. Events are
 * emitted only after the serial operation settles and can never change the
 * authoritative outcome.
 */
export class AdmissionAuthority implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const

  private readonly limits: AdmissionLimits
  private readonly policyEpoch: string
  private readonly roots: RootResolution
  private readonly ledger: AdmissionLedger
  private readonly guard: Pick<ProcessOwnershipGuard, 'assertHeld'>
  private readonly leases: ActiveLeaseRegistry
  private readonly clock: AdmissionClock
  private readonly onEvent: ((event: AdmissionAuthorityEvent) => void) | undefined
  private readonly onInternalDiagnostic:
    | ((diagnostic: string) => void)
    | undefined
  private readonly serial = new SerialSection()
  private admissionClosed = false
  private drainPromise: Promise<void> | undefined

  constructor(options: AdmissionAuthorityOptions) {
    assertLimits(options.limits)
    if (options.policyEpoch.length === 0) {
      throw new Error('policyEpoch must not be empty')
    }
    this.limits = Object.freeze({ ...options.limits })
    this.policyEpoch = options.policyEpoch
    this.roots = options.roots
    this.ledger = options.ledger
    this.guard = options.guard
    this.leases = options.leases ?? new ActiveLeaseRegistry()
    this.clock = options.clock ?? { now: Date.now }
    this.onEvent = options.onEvent
    this.onInternalDiagnostic = options.onInternalDiagnostic
  }

  async prepare(
    rawRequest: SubagentAdmissionRequestV1,
  ): Promise<SubagentAdmissionPermitV1> {
    const request = this.validateRequest(rawRequest)
    if (this.admissionClosed) {
      const error = this.denial(
        ADMISSION_ERROR_CODES.ADMISSION_CLOSED,
        request,
        '',
        0,
        0,
      )
      this.emitDenied(request, error)
      throw error
    }

    let resolvedRootId = ''
    let pendingDiagnostic: string | undefined
    try {
      const lease = await this.serial.run(async () => {
        this.assertOpen(request, resolvedRootId)
        try {
          await this.guard.assertHeld()
        } catch {
          throw this.denial(
            ADMISSION_ERROR_CODES.ADMISSION_UNAVAILABLE,
            request,
            resolvedRootId,
            0,
            0,
          )
        }

        let lineage: Awaited<ReturnType<RootResolution['resolve']>>
        try {
          lineage = await this.roots.resolve(request.parentSessionId)
        } catch (error) {
          throw this.normalizeError(error, request, resolvedRootId)
        }
        resolvedRootId = lineage.rootSessionId

        if (request.childSessionId !== undefined) {
          this.leases.assertChildAvailable(request.childSessionId)
        }

        const admittedAt = this.authoritativeNow(request, resolvedRootId)
        if (request.operation === 'cold-resume') {
          this.leases.assertRootThenGlobalCapacity(
            resolvedRootId,
            this.limits,
          )
        } else {
          const reservation: ReserveNewInput = {
            rootSessionId: resolvedRootId,
            parentSessionId: request.parentSessionId,
            limits: this.limits,
            now: admittedAt,
          }
          try {
            await this.ledger.reserveNew(reservation, (): void => {
              this.leases.assertRootThenGlobalCapacity(
                resolvedRootId,
                this.limits,
              )
            })
          } catch (error) {
            throw this.normalizeError(
              error,
              request,
              resolvedRootId,
              ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
            )
          }
        }

        try {
          return this.leases.insert({
            requestId: request.requestId,
            operation: request.operation,
            rootSessionId: resolvedRootId,
            parentSessionId: request.parentSessionId,
            admittedAt,
            ...(request.childSessionId === undefined
              ? {}
              : { expectedChildSessionId: request.childSessionId }),
            ...(request.operation === 'cold-resume'
              ? { initialChildSessionId: request.childSessionId }
              : {}),
          })
        } catch {
          this.closeAdmission()
          pendingDiagnostic = 'post-commit-lease-insertion-failed'
          throw this.denial(
            ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
            request,
            resolvedRootId,
            0,
            0,
          )
        }
      })

      this.emit(
        this.eventForLease('accepted', lease, {
          childSessionId: lease.childSessionId,
          code: null,
          reason: null,
          duplicate: false,
        }),
      )
      return new AdmissionPermit({
        bind: (binding): void => {
          this.bindLease(lease, binding)
        },
        release: (reason): Promise<void> => this.releaseLease(lease, reason),
        recordDuplicate: (reason): void => {
          this.recordDuplicateRelease(lease, reason)
        },
        rejectBinding: (): AdmissionAuthorityError =>
          this.bindingConflict(lease),
      })
    } catch (error) {
      const normalized = this.normalizeError(error, request, resolvedRootId)
      if (pendingDiagnostic !== undefined) {
        this.diagnostic(pendingDiagnostic)
      }
      this.emitDenied(request, normalized)
      throw normalized
    }
  }

  closeAdmission(): void {
    if (this.admissionClosed) {
      return
    }
    this.admissionClosed = true
    this.leases.markDraining()
  }

  drain(): Promise<void> {
    this.closeAdmission()
    this.drainPromise ??= (async (): Promise<void> => {
      await this.serial.idle()
      await this.leases.whenEmpty()
    })()
    return this.drainPromise
  }

  private bindLease(
    lease: ActiveLease,
    binding: {
      readonly childSessionId: string
      readonly localParentSessionId?: string
    },
  ): void {
    if (
      binding.localParentSessionId !== undefined &&
      binding.localParentSessionId !== lease.parentSessionId
    ) {
      throw this.bindingConflict(lease)
    }
    let inspection: ReturnType<ActiveLeaseRegistry['inspectBinding']>
    try {
      inspection = this.leases.inspectBinding(
        lease.permitId,
        binding.childSessionId,
      )
    } catch {
      throw this.bindingConflict(lease)
    }
    if (inspection === 'duplicate') {
      return
    }

    try {
      this.roots.bindChild({
        childSessionId: binding.childSessionId,
        expectedParentSessionId: lease.parentSessionId,
        expectedRootSessionId: lease.rootSessionId,
        ...(binding.localParentSessionId === undefined
          ? {}
          : { localParentSessionId: binding.localParentSessionId }),
      })
      this.leases.bind(lease.permitId, binding.childSessionId)
    } catch {
      throw this.bindingConflict(lease)
    }
  }

  private bindingConflict(lease: ActiveLease): AdmissionAuthorityError {
    return new AdmissionAuthorityError(
      createAdmissionDenied({
        code: ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT,
        operation: lease.operation,
        rootId: lease.rootSessionId,
        parentId: lease.parentSessionId,
        observedValue: 1,
        limit: 1,
        policyEpoch: this.policyEpoch,
        requestId: lease.requestId,
      }),
    )
  }

  private async releaseLease(
    lease: ActiveLease,
    reason: AdmissionReleaseReason,
  ): Promise<void> {
    let removed: ActiveLease | undefined
    try {
      removed = await this.serial.run(async () =>
        this.leases.remove(lease.permitId),
      )
    } catch {
      this.closeAdmission()
      this.diagnostic('lease-release-invariant-failed')
      throw new AdmissionAuthorityError(
        createAdmissionDenied({
          code: ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
          operation: lease.operation,
          rootId: lease.rootSessionId,
          parentId: lease.parentSessionId,
          observedValue: 0,
          limit: 0,
          policyEpoch: this.policyEpoch,
          requestId: lease.requestId,
        }),
      )
    }
    this.emitRelease(removed ?? lease, reason, removed === undefined)
  }

  private recordDuplicateRelease(
    lease: ActiveLease,
    reason: AdmissionReleaseReason,
  ): void {
    this.emitRelease(lease, reason, true)
  }

  private validateRequest(
    request: SubagentAdmissionRequestV1,
  ): SubagentAdmissionRequestV1 {
    const candidate = request as SubagentAdmissionRequestV1 | null | undefined
    const validOperation =
      candidate?.operation === 'new-one-shot' ||
      candidate?.operation === 'new-continuable' ||
      candidate?.operation === 'cold-resume'
    const valid =
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate.requestId === 'string' &&
      candidate.requestId.length > 0 &&
      validOperation &&
      typeof candidate.provider === 'string' &&
      candidate.provider.length > 0 &&
      typeof candidate.parentSessionId === 'string' &&
      candidate.parentSessionId.length > 0 &&
      (candidate.childSessionId === undefined ||
        (typeof candidate.childSessionId === 'string' &&
          candidate.childSessionId.length > 0)) &&
      (candidate.operation !== 'cold-resume' ||
        candidate.childSessionId !== undefined)
    if (!valid) {
      throw new AdmissionAuthorityError(
        createAdmissionDenied({
          code: ADMISSION_ERROR_CODES.ADMISSION_UNAVAILABLE,
          operation: 'new-one-shot',
          rootId: '',
          parentId: null,
          observedValue: 0,
          limit: 0,
          policyEpoch: this.policyEpoch,
          requestId: '',
        }),
      )
    }
    return Object.freeze({
      requestId: candidate.requestId,
      operation: candidate.operation,
      provider: candidate.provider,
      parentSessionId: candidate.parentSessionId,
      ...(candidate.childSessionId === undefined
        ? {}
        : { childSessionId: candidate.childSessionId }),
    })
  }

  private assertOpen(
    request: SubagentAdmissionRequestV1,
    rootId: string,
  ): void {
    if (this.admissionClosed) {
      throw this.denial(
        ADMISSION_ERROR_CODES.ADMISSION_CLOSED,
        request,
        rootId,
        0,
        0,
      )
    }
  }

  private authoritativeNow(
    request: SubagentAdmissionRequestV1,
    rootId: string,
  ): number {
    let now: number
    try {
      now = this.clock.now()
    } catch {
      throw this.denial(
        ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
        request,
        rootId,
        0,
        0,
      )
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw this.denial(
        ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
        request,
        rootId,
        0,
        0,
      )
    }
    return now
  }

  private normalizeError(
    error: unknown,
    request: SubagentAdmissionRequestV1,
    rootId: string,
    fallbackCode: AdmissionErrorCode =
      ADMISSION_ERROR_CODES.ADMISSION_UNAVAILABLE,
  ): AdmissionAuthorityError {
    if (error instanceof AdmissionAuthorityError) {
      return error
    }
    const code = readErrorCode(error)
    if (code === undefined) {
      return this.denial(
        fallbackCode,
        request,
        rootId,
        0,
        0,
      )
    }
    const { observedValue, limit } = this.errorCounts(error, code)
    return this.denial(
      code,
      request,
      rootId,
      observedValue,
      limit,
    )
  }

  private errorCounts(
    error: unknown,
    code: AdmissionErrorCode,
  ): { observedValue: number; limit: number } {
    const record = error as
      | { readonly observedValue?: unknown; readonly limit?: unknown }
      | null
    if (
      typeof record?.observedValue === 'number' &&
      Number.isFinite(record.observedValue) &&
      typeof record.limit === 'number' &&
      Number.isFinite(record.limit)
    ) {
      return {
        observedValue: record.observedValue,
        limit: record.limit,
      }
    }
    switch (code) {
      case ADMISSION_ERROR_CODES.ROOT_TOTAL_LIMIT:
        return {
          observedValue: this.limits.perRootAdmittedTotal,
          limit: this.limits.perRootAdmittedTotal,
        }
      case ADMISSION_ERROR_CODES.PARENT_CHILD_LIMIT:
        return {
          observedValue: this.limits.perParentChildren,
          limit: this.limits.perParentChildren,
        }
      case ADMISSION_ERROR_CODES.ROOT_ACTIVE_LIMIT:
        return {
          observedValue: this.limits.perRootActive,
          limit: this.limits.perRootActive,
        }
      case ADMISSION_ERROR_CODES.GLOBAL_ACTIVE_LIMIT:
        return {
          observedValue: this.limits.globalActive,
          limit: this.limits.globalActive,
        }
      default:
        return { observedValue: 0, limit: 0 }
    }
  }

  private denial(
    code: AdmissionErrorCode,
    request: SubagentAdmissionRequestV1,
    rootId: string,
    observedValue: number,
    limit: number,
  ): AdmissionAuthorityError {
    return new AdmissionAuthorityError(
      createAdmissionDenied({
        code,
        operation: request.operation,
        rootId,
        parentId: request.parentSessionId,
        observedValue,
        limit,
        policyEpoch: this.policyEpoch,
        requestId: request.requestId,
      }),
    )
  }

  private emitDenied(
    request: SubagentAdmissionRequestV1,
    error: AdmissionAuthorityError,
  ): void {
    this.emit(
      Object.freeze({
        kind: 'denied',
        time: this.telemetryNow(),
        requestId: request.requestId,
        operation: request.operation,
        rootId: error.rootId,
        parentSessionId: request.parentSessionId,
        childSessionId: request.childSessionId ?? null,
        code: error.code,
        reason: null,
        duplicate: false,
      }),
    )
  }

  private emitRelease(
    lease: ActiveLease,
    reason: AdmissionReleaseReason,
    duplicate: boolean,
  ): void {
    this.emit(
      this.eventForLease(
        reason === 'startup-failed' ? 'failed-start' : 'released',
        lease,
        {
          childSessionId: lease.childSessionId,
          code: null,
          reason,
          duplicate,
        },
      ),
    )
  }

  private eventForLease(
    kind: AdmissionAuthorityEvent['kind'],
    lease: ActiveLease,
    detail: Pick<
      AdmissionAuthorityEvent,
      'childSessionId' | 'code' | 'reason' | 'duplicate'
    >,
  ): AdmissionAuthorityEvent {
    return Object.freeze({
      kind,
      time: this.telemetryNow(),
      requestId: lease.requestId,
      operation: lease.operation,
      rootId: lease.rootSessionId,
      parentSessionId: lease.parentSessionId,
      childSessionId: detail.childSessionId,
      code: detail.code,
      reason: detail.reason,
      duplicate: detail.duplicate,
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

  private emit(event: AdmissionAuthorityEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Telemetry is non-authoritative and cannot reverse a transition.
    }
  }

  private diagnostic(diagnostic: string): void {
    try {
      this.onInternalDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics are non-authoritative and cannot reverse a transition.
    }
  }
}

const ADMISSION_CODES = new Set<string>(Object.values(ADMISSION_ERROR_CODES))

function readErrorCode(error: unknown): AdmissionErrorCode | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' && ADMISSION_CODES.has(code)
    ? (code as AdmissionErrorCode)
    : undefined
}

function assertLimits(limits: AdmissionLimits): void {
  const values = [
    limits.globalActive,
    limits.perRootActive,
    limits.perRootAdmittedTotal,
    limits.perParentChildren,
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('admission limits must be positive safe integers')
  }
  if (
    limits.perRootActive > limits.globalActive ||
    limits.perRootActive > limits.perRootAdmittedTotal ||
    limits.perParentChildren > limits.perRootAdmittedTotal
  ) {
    throw new Error('admission limits are incoherent')
  }
}
