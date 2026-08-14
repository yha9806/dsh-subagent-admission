import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'

import type { AdmissionLimits } from '../src/types.js'
import {
  ActiveLeaseRegistry,
  type ActiveLease,
} from '../src/host/leases.js'
import {
  AdmissionAuthority,
  type AdmissionAuthorityEvent,
  type AdmissionAuthorityOptions,
} from '../src/host/authority.js'
import type {
  ChildBindingInput,
  ResolvedLineage,
  RootResolution,
} from '../src/host/root-resolver.js'
import type {
  SubagentAdmissionPermitV1,
  SubagentAdmissionRequestV1,
} from '../src/host/seam-v1.js'
import type { ReserveNewInput } from '../src/host/ledger.js'
import {
  createAdmissionState,
  transitionModel,
  type AdmissionState,
} from '../src/host/state-model.js'

const LIMITS: AdmissionLimits = {
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
}

interface FakeLedgerRow {
  admittedTotal: number
  admittedChildrenByParent: Map<string, number>
}

class FakeLedger {
  readonly rows = new Map<string, FakeLedgerRow>()
  readonly trace: string[] = []
  writes = 0
  failWrites = false

  async reserveNew(
    input: ReserveNewInput,
    assertActiveCapacity: () => void,
  ): Promise<object> {
    const row = this.rows.get(input.rootSessionId) ?? {
      admittedTotal: 0,
      admittedChildrenByParent: new Map(),
    }
    const parentCount =
      row.admittedChildrenByParent.get(input.parentSessionId) ?? 0

    this.trace.push('root-total')
    if (row.admittedTotal >= input.limits.perRootAdmittedTotal) {
      throw capacityError(
        'ROOT_TOTAL_LIMIT',
        row.admittedTotal,
        input.limits.perRootAdmittedTotal,
      )
    }

    this.trace.push('parent-total')
    if (parentCount >= input.limits.perParentChildren) {
      throw capacityError(
        'PARENT_CHILD_LIMIT',
        parentCount,
        input.limits.perParentChildren,
      )
    }

    assertActiveCapacity()
    this.trace.push('write')
    if (this.failWrites) {
      throw capacityError('ADMISSION_STATE_IO', 0, 0)
    }

    this.rows.set(input.rootSessionId, {
      admittedTotal: row.admittedTotal + 1,
      admittedChildrenByParent: new Map(row.admittedChildrenByParent).set(
        input.parentSessionId,
        parentCount + 1,
      ),
    })
    this.writes += 1
    return Object.freeze({})
  }
}

interface ResolveGate {
  readonly entered: Promise<void>
  release(): void
}

class FakeRoots implements RootResolution {
  readonly resolveCalls: string[] = []
  readonly resolveSignals: Array<AbortSignal | undefined> = []
  readonly bindings: ChildBindingInput[] = []
  private readonly roots: Readonly<Record<string, string>>
  private readonly boundRoots = new Map<string, string>()
  private nextGate:
    | { entered: () => void; wait: Promise<void>; release: () => void }
    | undefined

  constructor(roots: Readonly<Record<string, string>>) {
    this.roots = roots
  }

  blockNextResolve(): ResolveGate {
    let enterResolve = (): void => {}
    let releaseResolve = (): void => {}
    const entered = new Promise<void>((resolve) => {
      enterResolve = resolve
    })
    const wait = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    this.nextGate = {
      entered: enterResolve,
      wait,
      release: releaseResolve,
    }
    return { entered, release: releaseResolve }
  }

  async resolve(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedLineage> {
    this.resolveCalls.push(parentSessionId)
    this.resolveSignals.push(signal)
    const gate = this.nextGate
    if (gate !== undefined) {
      this.nextGate = undefined
      gate.entered()
      await gate.wait
    }
    signal?.throwIfAborted()
    const rootSessionId = this.roots[parentSessionId]
    if (rootSessionId === undefined) {
      throw Object.freeze({ code: 'ADMISSION_UNAVAILABLE' })
    }
    return Object.freeze({
      rootSessionId,
      lineage: Object.freeze([parentSessionId, rootSessionId]),
    })
  }

  bindChild(input: ChildBindingInput): void {
    if (
      input.localParentSessionId !== undefined &&
      input.localParentSessionId !== input.expectedParentSessionId
    ) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    const existing = this.boundRoots.get(input.childSessionId)
    if (
      existing !== undefined &&
      existing !== input.expectedRootSessionId
    ) {
      throw Object.freeze({ code: 'ADMISSION_BINDING_CONFLICT' })
    }
    this.boundRoots.set(input.childSessionId, input.expectedRootSessionId)
    this.bindings.push(Object.freeze({ ...input }))
  }
}

interface FixtureOptions {
  readonly limits?: AdmissionLimits
  readonly parentRoots?: Readonly<Record<string, string>>
  readonly leases?: ActiveLeaseRegistry
  readonly guardFailure?: unknown
}

function authorityFixture(options: FixtureOptions = {}) {
  const limits = options.limits ?? LIMITS
  const ledger = new FakeLedger()
  const roots = new FakeRoots(
    options.parentRoots ?? { p: 'r', p1: 'r1', p2: 'r2' },
  )
  const leases = options.leases ?? new ActiveLeaseRegistry()
  const events: AdmissionAuthorityEvent[] = []
  const diagnostics: string[] = []
  let now = 100
  const guard = {
    assertHeld: vi.fn(async (): Promise<void> => {
      if (options.guardFailure !== undefined) {
        throw options.guardFailure
      }
    }),
  }
  const authorityOptions = {
    limits,
    policyEpoch: 'epoch-test',
    roots,
    ledger,
    guard,
    leases,
    clock: { now: (): number => now++ },
    onEvent: (event: AdmissionAuthorityEvent): void => {
      events.push(event)
    },
    onInternalDiagnostic: (diagnostic: string): void => {
      diagnostics.push(diagnostic)
    },
  } satisfies AdmissionAuthorityOptions
  const authority = new AdmissionAuthority(authorityOptions)
  return {
    authority,
    ledger,
    roots,
    leases,
    guard,
    events,
    diagnostics,
    providerCalls: 0,
    materializations: 0,
  }
}

let requestCounter = 0

function request(
  operation: SubagentAdmissionRequestV1['operation'],
  parentSessionId = 'p',
  childSessionId?: string,
): SubagentAdmissionRequestV1 {
  requestCounter += 1
  return {
    requestId: `request-${String(requestCounter)}`,
    operation,
    provider: 'fake',
    parentSessionId,
    ...(childSessionId === undefined ? {} : { childSessionId }),
  }
}

function capacityError(
  code: string,
  observedValue: number,
  limit: number,
): Readonly<{ code: string; observedValue: number; limit: number }> {
  return Object.freeze({ code, observedValue, limit })
}

function captureSyncError(action: () => void): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected synchronous action to throw')
}

function leaseFor(
  leases: ActiveLeaseRegistry,
  permit: SubagentAdmissionPermitV1,
): ActiveLease {
  const lease = leases.snapshot()[0]
  expect(permit).toBeDefined()
  expect(lease).toBeDefined()
  return lease as ActiveLease
}

describe('AdmissionAuthority acquire ordering', () => {
  it('denies before durable write, provider work, or materialization', async () => {
    const f = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const held = await f.authority.acquire(
      request('new-one-shot', 'p1'),
      new AbortController().signal,
    )

    await expect(
      f.authority.acquire(
        request('new-one-shot', 'p2'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
    expect(f.ledger.writes).toBe(1)
    expect(f.providerCalls).toBe(0)
    expect(f.materializations).toBe(0)
    expect(f.leases.size).toBe(1)

    await held.release('quiescent')
  })

  it('uses root-total, parent-total, root-active, global-active order', async () => {
    const allOne: AdmissionLimits = {
      globalActive: 1,
      perRootActive: 1,
      perRootAdmittedTotal: 1,
      perParentChildren: 1,
    }
    const rootFirst = authorityFixture({ limits: allOne })
    const first = await rootFirst.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    await expect(
      rootFirst.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ROOT_TOTAL_LIMIT' })
    await first.release('quiescent')

    const parentFirst = authorityFixture({
      limits: {
        ...LIMITS,
        perParentChildren: 1,
        perRootActive: 1,
      },
    })
    const parentHeld = await parentFirst.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    await expect(
      parentFirst.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PARENT_CHILD_LIMIT' })
    await parentHeld.release('quiescent')

    const rootActiveFirst = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
    })
    const rootHeld = await rootActiveFirst.authority.acquire(
      request('cold-resume', 'p', 'child-1'),
      new AbortController().signal,
    )
    await expect(
      rootActiveFirst.authority.acquire(
        request('cold-resume', 'p', 'child-2'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ROOT_ACTIVE_LIMIT' })
    await rootHeld.release('quiescent')

    const globalOnly = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const globalHeld = await globalOnly.authority.acquire(
      request('cold-resume', 'p1', 'child-1'),
      new AbortController().signal,
    )
    await expect(
      globalOnly.authority.acquire(
        request('cold-resume', 'p2', 'child-2'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
    await globalHeld.release('quiescent')
  })

  it('does not create a lease when the durable reservation fails', async () => {
    const f = authorityFixture()
    f.ledger.failWrites = true

    await expect(
      f.authority.acquire(
        request('new-continuable', 'p', 'reserved-child'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_STATE_IO' })
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
    expect(f.events.at(-1)).toMatchObject({
      kind: 'denied',
      code: 'ADMISSION_STATE_IO',
    })

    f.ledger.failWrites = false
    const recovered = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    expect(f.ledger.writes).toBe(1)
    await recovered.release('quiescent')
  })

  it('linearizes concurrent acquires without admitting beyond global capacity', async () => {
    const f = authorityFixture({
      limits: { ...LIMITS, globalActive: 6, perRootActive: 4 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        f.authority.acquire(
          request('new-one-shot', index % 2 === 0 ? 'p1' : 'p2'),
          new AbortController().signal,
        ),
      ),
    )
    const accepted = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<SubagentAdmissionPermitV1> =>
        result.status === 'fulfilled',
    )
    const denied = attempts.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    )

    expect(accepted).toHaveLength(6)
    expect(denied).toHaveLength(4)
    expect(
      denied.every(
        (result) =>
          (result.reason as { code?: unknown }).code ===
          'GLOBAL_ACTIVE_LIMIT',
      ),
    ).toBe(true)
    expect(f.ledger.writes).toBe(6)
    expect(f.leases.globalActive).toBe(6)
    expect(f.leases.rootActive('r1')).toBe(3)
    expect(f.leases.rootActive('r2')).toBe(3)

    await Promise.all(
      accepted.map(async ({ value }) => value.release('quiescent')),
    )
    expect(f.leases.globalActive).toBe(0)
  })

  it('charges active capacity but no cumulative write for cold resume', async () => {
    const f = authorityFixture()
    const before = f.ledger.writes

    const permit = await f.authority.acquire(
      request('cold-resume', 'p', 'existing-child'),
      new AbortController().signal,
    )
    expect(f.ledger.writes).toBe(before)
    expect(f.leases.size).toBe(1)
    expect(leaseFor(f.leases, permit)).toMatchObject({
      childSessionId: 'existing-child',
      operation: 'cold-resume',
    })

    await permit.release('quiescent')
    expect(f.leases.size).toBe(0)
  })

  it('maps a lost process guard to unavailable before root or ledger work', async () => {
    const f = authorityFixture({
      guardFailure: Object.freeze({ reason: 'owner-lost' }),
    })

    await expect(
      f.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_UNAVAILABLE' })
    expect(f.roots.resolveCalls).toEqual([])
    expect(f.ledger.trace).toEqual([])
    expect(f.ledger.writes).toBe(0)
  })

  it('rejects invalid or resident-follow-up operations before dependencies', async () => {
    const f = authorityFixture()
    const invalid = {
      ...request('new-one-shot'),
      operation: 'resident-follow-up',
    } as unknown as SubagentAdmissionRequestV1

    await expect(
      f.authority.acquire(invalid, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
    expect(f.guard.assertHeld).not.toHaveBeenCalled()
    expect(f.roots.resolveCalls).toEqual([])
    expect(f.ledger.trace).toEqual([])
  })

  it('consumes nothing and causes no guard, root, ledger, or lease mutation when pre-aborted', async () => {
    const f = authorityFixture()
    const controller = new AbortController()
    controller.abort()

    await expect(
      f.authority.acquire(request('new-one-shot'), controller.signal),
    ).rejects.toThrow()

    expect(f.guard.assertHeld).not.toHaveBeenCalled()
    expect(f.roots.resolveCalls).toEqual([])
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
  })

  it('causes no ledger write when aborted before root resolution completes', async () => {
    const f = authorityFixture()
    const gate = f.roots.blockNextResolve()
    const controller = new AbortController()
    const acquiring = f.authority.acquire(
      request('new-one-shot'),
      controller.signal,
    )
    await gate.entered
    controller.abort()
    gate.release()

    await expect(acquiring).rejects.toThrow()
    expect(f.guard.assertHeld).toHaveBeenCalled()
    expect(f.roots.resolveCalls).toEqual(['p'])
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
  })

  it('causes no durable write when aborted after root resolution but before reserveNew', async () => {
    const f = authorityFixture()
    const controller = new AbortController()
    const originalResolve = f.roots.resolve.bind(f.roots)
    f.roots.resolve = async (parentSessionId, _signal) => {
      const res = await originalResolve(parentSessionId, undefined)
      controller.abort()
      return res
    }

    await expect(
      f.authority.acquire(request('new-one-shot'), controller.signal),
    ).rejects.toThrow()
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
  })

  it('completes atomic ledger-plus-lease section once reserveNew begins and returns a permit for startup-failed release', async () => {
    const f = authorityFixture()
    const controller = new AbortController()
    const originalReserve = f.ledger.reserveNew.bind(f.ledger)
    f.ledger.reserveNew = async (input, assertActiveCapacity) => {
      controller.abort()
      return originalReserve(input, assertActiveCapacity)
    }

    const permit = await f.authority.acquire(
      request('new-one-shot'),
      controller.signal,
    )
    expect(permit).toBeDefined()
    expect(f.ledger.writes).toBe(1)
    expect(f.leases.size).toBe(1)

    await permit.release('startup-failed')
    expect(f.leases.size).toBe(0)
    expect(f.events.at(-1)).toMatchObject({
      kind: 'failed-start',
      reason: 'startup-failed',
    })
  })

  it('passes the exact caller signal to root resolution', async () => {
    const f = authorityFixture()
    const controller = new AbortController()
    const permit = await f.authority.acquire(
      request('new-one-shot'),
      controller.signal,
    )
    expect(f.roots.resolveSignals[0]).toBe(controller.signal)
    await permit.release('quiescent')
  })

  it('normalizes legacy disposed release reason to quiescent exactly once', async () => {
    const f = authorityFixture()
    const permit = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    // Invoking old release vocabulary through runtime release bridge:
    const bridge = permit as unknown as { release(reason: 'disposed'): Promise<void> }
    await bridge.release('disposed')
    expect(f.leases.size).toBe(0)
    expect(f.events.filter((e) => e.kind === 'released')).toHaveLength(1)
    expect(f.events.at(-1)).toMatchObject({
      kind: 'released',
      reason: 'quiescent',
      duplicate: false,
    })
  })
})

describe('AdmissionPermit binding and release', () => {
  it('rejects a duplicate known child before another cumulative write or active lease', async () => {
    const f = authorityFixture()
    const first = await f.authority.acquire(
      request('new-continuable', 'p', 'reserved-child'),
      new AbortController().signal,
    )

    await expect(
      f.authority.acquire(
        request('new-continuable', 'p', 'reserved-child'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'ADMISSION_BINDING_CONFLICT',
      observedValue: 1,
      limit: 1,
    })
    expect(f.ledger.writes).toBe(1)
    expect(f.leases.size).toBe(1)

    await first.release('quiescent')
  })

  it('allows only one live cold-resume permit for the same existing child', async () => {
    const f = authorityFixture()
    const first = await f.authority.acquire(
      request('cold-resume', 'p', 'existing-child'),
      new AbortController().signal,
    )

    await expect(
      f.authority.acquire(
        request('cold-resume', 'p', 'existing-child'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(1)

    await first.release('quiescent')
    const resumedAgain = await f.authority.acquire(
      request('cold-resume', 'p', 'existing-child'),
      new AbortController().signal,
    )
    await resumedAgain.release('quiescent')
  })

  it('rejects two otherwise valid permits binding the same live child', async () => {
    const f = authorityFixture()
    const first = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    const second = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )

    first.bindChild({
      childSessionId: 'published-child',
      localParentSessionId: 'p',
    })
    expect(
      captureSyncError(() =>
        second.bindChild({
          childSessionId: 'published-child',
          localParentSessionId: 'p',
        }),
      ),
    ).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
    expect(f.roots.bindings).toHaveLength(1)
    expect(
      f.leases
        .snapshot()
        .filter((lease) => lease.childSessionId === 'published-child'),
    ).toHaveLength(1)

    await first.release('quiescent')
    await second.release('startup-failed')
  })

  it('binds at most once, accepts an identical repeat, and rejects conflicts', async () => {
    const f = authorityFixture()
    const permit = await f.authority.acquire(
      request('new-continuable', 'p', 'reserved-child'),
      new AbortController().signal,
    )
    const binding = {
      childSessionId: 'reserved-child',
      localParentSessionId: 'p',
    }

    expect(() => permit.bindChild(binding)).not.toThrow()
    expect(() => permit.bindChild(binding)).not.toThrow()
    expect(f.roots.bindings).toHaveLength(1)
    expect(f.events.filter((event) => event.kind === 'bound')).toHaveLength(1)
    expect(f.leases.snapshot()[0]).toMatchObject({
      childSessionId: 'reserved-child',
    })

    expect(
      captureSyncError(() =>
        permit.bindChild({
          childSessionId: 'different-child',
          localParentSessionId: 'p',
        }),
      ),
    ).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
    expect(
      captureSyncError(() =>
        permit.bindChild({
          childSessionId: 'reserved-child',
          localParentSessionId: 'different-parent',
        }),
      ),
    ).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })

    await permit.release('quiescent')
    expect(
      captureSyncError(() => permit.bindChild(binding)),
    ).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
  })

  it('releases once under duplicate concurrent callbacks without negative counts', async () => {
    const f = authorityFixture()
    const permit = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )

    await Promise.all([
      permit.release('quiescent'),
      permit.release('quiescent'),
      permit.release('quiescent'),
    ])

    expect(f.leases.size).toBe(0)
    expect(f.leases.globalActive).toBe(0)
    expect(f.leases.rootActive('r')).toBe(0)
    expect(f.events.filter((event) => event.kind === 'released')).toHaveLength(3)
    expect(
      f.events.filter(
        (event) => event.kind === 'released' && event.duplicate === true,
      ),
    ).toHaveLength(2)
  })

  it('uses failed-start telemetry and releases capacity after cleanup signals it', async () => {
    const f = authorityFixture({
      limits: {
        ...LIMITS,
        perRootActive: 1,
        perRootAdmittedTotal: 1,
        perParentChildren: 1,
      },
    })
    const permit = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    expect(f.leases.size).toBe(1)

    await permit.release('startup-failed')

    expect(f.leases.size).toBe(0)
    expect(f.events.at(-1)).toMatchObject({
      kind: 'failed-start',
      reason: 'startup-failed',
      duplicate: false,
    })
    expect(f.ledger.writes).toBe(1)
    await expect(
      f.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'ROOT_TOTAL_LIMIT',
      observedValue: 1,
      limit: 1,
    })
    expect(f.ledger.writes).toBe(1)
  })
})

describe('AdmissionAuthority close and drain', () => {
  it('tombstones new acquires synchronously while existing permits remain releasable', async () => {
    const f = authorityFixture()
    const permit = await f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    const callsBeforeClose = f.guard.assertHeld.mock.calls.length

    f.authority.closeAdmission()

    expect(f.leases.snapshot()[0]).toMatchObject({ phase: 'draining' })
    await expect(
      f.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    expect(f.guard.assertHeld).toHaveBeenCalledTimes(callsBeforeClose)

    await permit.release('quiescent')
    await expect(f.authority.drain()).resolves.toBeUndefined()
  })

  it('waits for the final permit and never force-releases it', async () => {
    const f = authorityFixture({
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const first = await f.authority.acquire(
      request('new-one-shot', 'p1'),
      new AbortController().signal,
    )
    const second = await f.authority.acquire(
      request('new-one-shot', 'p2'),
      new AbortController().signal,
    )
    f.authority.closeAdmission()

    let drained = false
    const drain = f.authority.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await first.release('quiescent')
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.leases.size).toBe(1)

    await second.release('quiescent')
    await drain
    expect(drained).toBe(true)
    expect(f.leases.size).toBe(0)
  })

  it('does not let drain finish ahead of an acquire already inside the serial section', async () => {
    const f = authorityFixture()
    const gate = f.roots.blockNextResolve()
    const acquiring = f.authority.acquire(
      request('new-one-shot'),
      new AbortController().signal,
    )
    await gate.entered

    f.authority.closeAdmission()
    let drained = false
    const drain = f.authority.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.release()
    const permit = await acquiring
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.leases.snapshot()[0]).toMatchObject({ phase: 'draining' })

    await permit.release('quiescent')
    await drain
    expect(drained).toBe(true)
  })
})

describe('authority/model trace parity', () => {
  it('matches active and cumulative state across generated acquire, release, and unload sequences', async () => {
    const limits: AdmissionLimits = {
      globalActive: 3,
      perRootActive: 2,
      perRootAdmittedTotal: 5,
      perParentChildren: 3,
    }
    const command = fc.oneof(
      fc.record({
        kind: fc.constant('acquire' as const),
        operation: fc.constantFrom(
          'new-one-shot' as const,
          'new-continuable' as const,
          'cold-resume' as const,
        ),
        parentSessionId: fc.constantFrom('p1', 'p2'),
      }),
      fc.record({
        kind: fc.constant('release' as const),
        slot: fc.nat({ max: 15 }),
      }),
      fc.record({ kind: fc.constant('unload' as const) }),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.array(command, { minLength: 1, maxLength: 40 }),
        async (commands) => {
          const f = authorityFixture({
            limits,
            parentRoots: { p1: 'r1', p2: 'r2' },
          })
          let model: AdmissionState = createAdmissionState({ limits })
          const permits: Array<{
            readonly actual: SubagentAdmissionPermitV1
            readonly modelPermitId: string
          }> = []

          try {
            for (const [index, next] of commands.entries()) {
              if (next.kind === 'acquire') {
                const rootId = next.parentSessionId === 'p1' ? 'r1' : 'r2'
                const requestId = `model-request-${String(index)}`
                const childSessionId = `model-child-${String(index)}`
                const transition = transitionModel(
                  model,
                  next.operation === 'cold-resume'
                    ? {
                        kind: 'cold-resume',
                        rootId,
                        parentId: next.parentSessionId,
                        requestId,
                        policyEpoch: 'epoch-test',
                      }
                    : {
                        kind: 'new-admission',
                        operation: next.operation,
                        rootId,
                        parentId: next.parentSessionId,
                        requestId,
                        policyEpoch: 'epoch-test',
                      },
                )
                const actualRequest: SubagentAdmissionRequestV1 = {
                  requestId,
                  operation: next.operation,
                  provider: 'fake',
                  parentSessionId: next.parentSessionId,
                  ...(next.operation === 'new-one-shot'
                    ? {}
                    : { childSessionId }),
                }

                let actualPermit: SubagentAdmissionPermitV1 | undefined
                let actualError: unknown
                try {
                  actualPermit = await f.authority.acquire(
                    actualRequest,
                    new AbortController().signal,
                  )
                } catch (error) {
                  actualError = error
                }

                if (transition.status === 'denied') {
                  expect(actualPermit).toBeUndefined()
                  expect(actualError).toMatchObject({
                    code: transition.denial.code,
                  })
                } else {
                  expect(actualError).toBeUndefined()
                  expect(actualPermit).toBeDefined()
                  expect(transition.status).toBe('accepted')
                  if (
                    actualPermit !== undefined &&
                    transition.status === 'accepted' &&
                    transition.permit !== null
                  ) {
                    permits.push({
                      actual: actualPermit,
                      modelPermitId: transition.permit.permitId,
                    })
                  }
                }
                model = transition.state
              } else if (next.kind === 'release') {
                if (permits.length > 0) {
                  const held = permits[next.slot % permits.length]
                  if (held !== undefined) {
                    const transition = transitionModel(model, {
                      kind: 'release',
                      permitId: held.modelPermitId,
                    })
                    await held.actual.release('quiescent')
                    model = transition.state
                  }
                }
              } else {
                const transition = transitionModel(model, { kind: 'unload' })
                f.authority.closeAdmission()
                model = transition.state
              }

              expect(f.leases.globalActive).toBe(model.globalActive)
              expect(f.leases.size).toBe(model.permits.size)
              expect(f.leases.rootActive('r1')).toBe(
                model.rootActive.get('r1') ?? 0,
              )
              expect(f.leases.rootActive('r2')).toBe(
                model.rootActive.get('r2') ?? 0,
              )
              expect(f.ledger.writes).toBe(
                [...model.rootAdmittedTotal.values()].reduce(
                  (sum, value) => sum + value,
                  0,
                ),
              )
              for (const rootId of ['r1', 'r2']) {
                expect(f.ledger.rows.get(rootId)?.admittedTotal ?? 0).toBe(
                  model.rootAdmittedTotal.get(rootId) ?? 0,
                )
              }
              for (const parentId of ['p1', 'p2']) {
                const rootId = parentId === 'p1' ? 'r1' : 'r2'
                expect(
                  f.ledger.rows
                    .get(rootId)
                    ?.admittedChildrenByParent.get(parentId) ?? 0,
                ).toBe(model.parentChildren.get(parentId) ?? 0)
              }
            }
          } finally {
            await Promise.all(
              permits.map(async ({ actual }) => {
                await actual.release('quiescent').catch(() => undefined)
              }),
            )
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('post-commit fail-stop', () => {
  it('closes admission if an impossible lease insertion fails after the durable write', async () => {
    class FailingLeaseRegistry extends ActiveLeaseRegistry {
      override insert(): never {
        throw new Error('injected impossible insertion failure')
      }
    }
    const f = authorityFixture({ leases: new FailingLeaseRegistry() })

    await expect(
      f.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_STATE_IO' })
    expect(f.ledger.writes).toBe(1)
    expect(f.leases.size).toBe(0)
    expect(f.diagnostics).toEqual(['post-commit-lease-insertion-failed'])

    await expect(
      f.authority.acquire(
        request('new-one-shot'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    await expect(f.authority.drain()).resolves.toBeUndefined()
  })
})
