import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AdmissionLimits } from '../types.js'
import { cloneFrozenRootLedgerRow, rootLedgerDomainSpec, type RootLedgerRow } from './ledger-spec.js'

export interface LedgerProbe {
  readonly writes: number
  didWrite(): void
}

export interface ReserveNewInput {
  readonly rootSessionId: string
  readonly parentSessionId: string
  readonly limits: AdmissionLimits
  readonly now: number
}

export type LedgerErrorCode =
  | 'ADMISSION_STATE_IO'
  | 'ROOT_TOTAL_LIMIT'
  | 'PARENT_CHILD_LIMIT'

export class LedgerOperationalError extends Error {
  readonly code: LedgerErrorCode
  readonly rootSessionId: string
  readonly parentSessionId: string

  constructor(code: LedgerErrorCode, rootSessionId: string, parentSessionId: string) {
    super(`Ledger operational error: ${code}`)
    Object.defineProperty(this, 'name', {
      value: 'LedgerOperationalError',
      enumerable: false,
      writable: true,
      configurable: true,
    })
    this.code = code
    this.rootSessionId = rootSessionId
    this.parentSessionId = parentSessionId
    Object.freeze(this)
  }
}

/** Internal probe that counts nothing: the default for uninstrumented stores. */
const NOOP_PROBE: LedgerProbe = {
  writes: 0,
  didWrite: (): void => {},
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Root admission ledger over one storage domain. `reserveNew` runs in a
 * private promise-tail critical section spanning the synchronous read,
 * cumulative checks, active assertion, and one durable write; `close`
 * atomically rejects new operations, drains the tail, then closes the domain
 * exactly once.
 */
export class RootLedgerStore {
  private readonly domain: Domain<typeof rootLedgerDomainSpec>
  private readonly roots: KvTable<string, RootLedgerRow>
  private readonly probe: LedgerProbe
  private closed = false
  private closing: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()

  private constructor(
    domain: Domain<typeof rootLedgerDomainSpec>,
    probe: LedgerProbe,
  ) {
    this.domain = domain
    this.roots = domain.table('roots')
    this.probe = probe
  }

  static async open(
    storageDomain: Pick<DomainFacility, 'open'>,
    probe: LedgerProbe = NOOP_PROBE,
  ): Promise<RootLedgerStore> {
    try {
      const domain = await storageDomain.open(rootLedgerDomainSpec)
      return new RootLedgerStore(domain, probe)
    } catch {
      throw new LedgerOperationalError('ADMISSION_STATE_IO', '', '')
    }
  }

  /** Appends one operation to the tail; a rejection never poisons the chain. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then((): void => {}, (): void => {})
    return result
  }

  async reserveNew(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<RootLedgerRow> {
    if (this.closed) throw new LedgerOperationalError('ADMISSION_STATE_IO', input.rootSessionId, input.parentSessionId)
    assertValidReservation(input)
    return this.enqueue(() => this.reserveNewLocked(input, assertActiveCapacity))
  }

  async read(rootId: string): Promise<Readonly<RootLedgerRow> | undefined> {
    if (this.closed || rootId.length === 0) throw new LedgerOperationalError('ADMISSION_STATE_IO', rootId, '')
    return this.enqueue(async () => {
      try {
        const row = this.roots.get(rootId)
        return row === undefined ? undefined : cloneFrozenRootLedgerRow(row)
      } catch {
        throw new LedgerOperationalError('ADMISSION_STATE_IO', rootId, '')
      }
    })
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.closing = this.tail
      .then(() => this.domain.close())
      .catch(() => { throw new LedgerOperationalError('ADMISSION_STATE_IO', '', '') })
    return this.closing
  }

  private async reserveNewLocked(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<RootLedgerRow> {
    const current = this.readCurrentRow(input)
    const admittedTotal = current?.admittedTotal ?? 0
    const childCounts = current?.admittedChildrenByParent
    const rawCount = childCounts?.[input.parentSessionId]
    const parentCount = typeof rawCount === 'number' ? rawCount : 0

    if (admittedTotal >= input.limits.perRootAdmittedTotal) {
      throw new LedgerOperationalError('ROOT_TOTAL_LIMIT', input.rootSessionId, input.parentSessionId)
    }
    if (parentCount >= input.limits.perParentChildren) {
      throw new LedgerOperationalError('PARENT_CHILD_LIMIT', input.rootSessionId, input.parentSessionId)
    }

    const callbackResult = assertActiveCapacity()
    let then: unknown
    try {
      then = (callbackResult as { then?: unknown } | null | undefined)?.then
    } catch {
      throw new LedgerOperationalError('ADMISSION_STATE_IO', input.rootSessionId, input.parentSessionId)
    }
    if (typeof then === 'function') {
      Promise.resolve(callbackResult).catch(() => {})
      throw new LedgerOperationalError('ADMISSION_STATE_IO', input.rootSessionId, input.parentSessionId)
    }

    const admittedChildrenByParent: Record<string, number> = Object.assign(
      Object.create(null) as Record<string, number>,
      current?.admittedChildrenByParent,
    )
    admittedChildrenByParent[input.parentSessionId] = parentCount + 1
    Object.freeze(admittedChildrenByParent)

    const next: RootLedgerRow = Object.freeze<RootLedgerRow>({
      schemaVersion: 1,
      rootSessionId: input.rootSessionId,
      coverageStartedAt: current?.coverageStartedAt ?? input.now,
      admittedTotal: admittedTotal + 1,
      admittedChildrenByParent,
      revision: (current?.revision ?? 0) + 1,
    })

    try {
      await this.roots.put(input.rootSessionId, next)
    } catch {
      throw new LedgerOperationalError('ADMISSION_STATE_IO', input.rootSessionId, input.parentSessionId)
    }
    try {
      this.probe.didWrite()
    } catch {
      // Probe instrumentation must never turn a durable acceptance into a failure.
    }
    return next
  }

  private readCurrentRow(input: ReserveNewInput): RootLedgerRow | undefined {
    try {
      return this.roots.get(input.rootSessionId)
    } catch {
      throw new LedgerOperationalError('ADMISSION_STATE_IO', input.rootSessionId, input.parentSessionId)
    }
  }
}

function assertValidReservation(input: ReserveNewInput): void {
  const limits = input.limits as AdmissionLimits | null | undefined
  const valid =
    typeof input.rootSessionId === 'string' && input.rootSessionId.length > 0 &&
    typeof input.parentSessionId === 'string' && input.parentSessionId.length > 0 &&
    Number.isSafeInteger(input.now) && input.now >= 0 &&
    limits !== null && limits !== undefined &&
    isPositiveSafeInteger(limits.globalActive) && isPositiveSafeInteger(limits.perRootActive) &&
    isPositiveSafeInteger(limits.perRootAdmittedTotal) && isPositiveSafeInteger(limits.perParentChildren)
  if (!valid) {
    throw new LedgerOperationalError(
      'ADMISSION_STATE_IO',
      input.rootSessionId,
      input.parentSessionId,
    )
  }
}
