import type { AdmissionLimits, AdmissionOperation } from '../types.js'

export type ActiveCapacityErrorCode =
  | 'ROOT_ACTIVE_LIMIT'
  | 'GLOBAL_ACTIVE_LIMIT'

export class ActiveCapacityError extends Error {
  readonly code: ActiveCapacityErrorCode
  readonly observedValue: number
  readonly limit: number

  constructor(
    code: ActiveCapacityErrorCode,
    observedValue: number,
    limit: number,
  ) {
    super(`Active capacity unavailable: ${code}`)
    Object.defineProperty(this, 'name', {
      value: 'ActiveCapacityError',
      enumerable: false,
      writable: true,
      configurable: true,
    })
    this.code = code
    this.observedValue = observedValue
    this.limit = limit
    Object.freeze(this)
  }
}

export class LeaseBindingConflict extends Error {
  readonly code = 'ADMISSION_BINDING_CONFLICT' as const

  constructor() {
    super('Admission lease binding conflict')
    Object.defineProperty(this, 'name', {
      value: 'LeaseBindingConflict',
      enumerable: false,
      writable: true,
      configurable: true,
    })
    Object.freeze(this)
  }
}

export interface ActiveLease {
  readonly permitId: string
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly rootSessionId: string
  readonly parentSessionId: string
  readonly expectedChildSessionId: string | null
  readonly childSessionId: string | null
  readonly admittedAt: number
  readonly phase: 'active' | 'draining'
}

export interface ActiveLeaseInsert {
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly rootSessionId: string
  readonly parentSessionId: string
  readonly expectedChildSessionId?: string
  readonly initialChildSessionId?: string
  readonly admittedAt: number
}

export type LeaseBindResult = 'bound' | 'duplicate'

/**
 * Process-local authoritative active ownership.
 *
 * Every mutating path is synchronous and contains no I/O or caller callback.
 * The authority serializes insertion and removal around its durable section;
 * this registry supplies the root-then-global capacity check used inside the
 * ledger callback.
 */
export class ActiveLeaseRegistry {
  private readonly leases = new Map<string, ActiveLease>()
  private readonly activeByRoot = new Map<string, number>()
  private readonly emptyWaiters = new Set<() => void>()
  private permitCounter = 0
  private draining = false

  get size(): number {
    return this.leases.size
  }

  get globalActive(): number {
    return this.leases.size
  }

  rootActive(rootSessionId: string): number {
    return this.activeByRoot.get(rootSessionId) ?? 0
  }

  assertRootThenGlobalCapacity(
    rootSessionId: string,
    limits: AdmissionLimits,
  ): void {
    const rootActive = this.rootActive(rootSessionId)
    if (rootActive >= limits.perRootActive) {
      throw new ActiveCapacityError(
        'ROOT_ACTIVE_LIMIT',
        rootActive,
        limits.perRootActive,
      )
    }
    if (this.globalActive >= limits.globalActive) {
      throw new ActiveCapacityError(
        'GLOBAL_ACTIVE_LIMIT',
        this.globalActive,
        limits.globalActive,
      )
    }
  }

  insert(input: ActiveLeaseInsert): ActiveLease {
    assertInsert(input)
    const permitId = `permit-${String(this.permitCounter)}`
    if (this.leases.has(permitId)) {
      throw new Error('duplicate admission permit id')
    }
    const lease = freezeLease({
      permitId,
      requestId: input.requestId,
      operation: input.operation,
      rootSessionId: input.rootSessionId,
      parentSessionId: input.parentSessionId,
      expectedChildSessionId: input.expectedChildSessionId ?? null,
      childSessionId: input.initialChildSessionId ?? null,
      admittedAt: input.admittedAt,
      phase: this.draining ? 'draining' : 'active',
    })
    const rootActive = this.rootActive(input.rootSessionId)
    this.leases.set(permitId, lease)
    this.activeByRoot.set(input.rootSessionId, rootActive + 1)
    this.permitCounter += 1
    return lease
  }

  get(permitId: string): ActiveLease | undefined {
    return this.leases.get(permitId)
  }

  bind(permitId: string, childSessionId: string): LeaseBindResult {
    const lease = this.leases.get(permitId)
    if (lease === undefined || childSessionId.length === 0) {
      throw new LeaseBindingConflict()
    }
    if (
      lease.expectedChildSessionId !== null &&
      lease.expectedChildSessionId !== childSessionId
    ) {
      throw new LeaseBindingConflict()
    }
    if (lease.childSessionId === childSessionId) {
      return 'duplicate'
    }
    if (lease.childSessionId !== null) {
      throw new LeaseBindingConflict()
    }
    this.leases.set(
      permitId,
      freezeLease({ ...lease, childSessionId }),
    )
    return 'bound'
  }

  remove(permitId: string): ActiveLease | undefined {
    const lease = this.leases.get(permitId)
    if (lease === undefined) {
      return undefined
    }
    const rootActive = this.activeByRoot.get(lease.rootSessionId)
    if (rootActive === undefined || rootActive <= 0) {
      throw new Error('active lease root count invariant failed')
    }
    this.leases.delete(permitId)
    if (rootActive === 1) {
      this.activeByRoot.delete(lease.rootSessionId)
    } else {
      this.activeByRoot.set(lease.rootSessionId, rootActive - 1)
    }
    if (this.leases.size === 0) {
      const waiters = [...this.emptyWaiters]
      this.emptyWaiters.clear()
      for (const resolve of waiters) {
        resolve()
      }
    }
    return lease
  }

  markDraining(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    for (const [permitId, lease] of this.leases) {
      this.leases.set(
        permitId,
        freezeLease({ ...lease, phase: 'draining' }),
      )
    }
  }

  whenEmpty(): Promise<void> {
    if (this.leases.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.emptyWaiters.add(resolve)
    })
  }

  snapshot(): readonly ActiveLease[] {
    return Object.freeze([...this.leases.values()])
  }
}

function freezeLease(lease: ActiveLease): ActiveLease {
  return Object.freeze(lease)
}

function assertInsert(input: ActiveLeaseInsert): void {
  const validOperation =
    input.operation === 'new-one-shot' ||
    input.operation === 'new-continuable' ||
    input.operation === 'cold-resume'
  const valid =
    input.requestId.length > 0 &&
    validOperation &&
    input.rootSessionId.length > 0 &&
    input.parentSessionId.length > 0 &&
    Number.isSafeInteger(input.admittedAt) &&
    input.admittedAt >= 0 &&
    (input.expectedChildSessionId === undefined ||
      input.expectedChildSessionId.length > 0) &&
    (input.initialChildSessionId === undefined ||
      input.initialChildSessionId.length > 0)
  if (!valid) {
    throw new Error('invalid active lease insertion')
  }
}
