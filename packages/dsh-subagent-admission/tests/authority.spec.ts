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

  async resolve(parentSessionId: string): Promise<ResolvedLineage> {
    this.resolveCalls.push(parentSessionId)
    const gate = this.nextGate
    if (gate !== undefined) {
      this.nextGate = undefined
      gate.entered()
      await gate.wait
    }
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

describe('AdmissionAuthority prepare ordering', () => {
  it('denies before durable write, provider work, or materialization', async () => {
    const f = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const held = await f.authority.prepare(request('new-one-shot', 'p1'))

    await expect(
      f.authority.prepare(request('new-one-shot', 'p2')),
    ).rejects.toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
    expect(f.ledger.writes).toBe(1)
    expect(f.providerCalls).toBe(0)
    expect(f.materializations).toBe(0)
    expect(f.leases.size).toBe(1)

    await held.release('disposed')
  })

  it('uses root-total, parent-total, root-active, global-active order', async () => {
    const allOne: AdmissionLimits = {
      globalActive: 1,
      perRootActive: 1,
      perRootAdmittedTotal: 1,
      perParentChildren: 1,
    }
    const rootFirst = authorityFixture({ limits: allOne })
    const first = await rootFirst.authority.prepare(
      request('new-one-shot'),
    )
    await expect(
      rootFirst.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({ code: 'ROOT_TOTAL_LIMIT' })
    await first.release('disposed')

    const parentFirst = authorityFixture({
      limits: {
        ...LIMITS,
        perParentChildren: 1,
        perRootActive: 1,
      },
    })
    const parentHeld = await parentFirst.authority.prepare(
      request('new-one-shot'),
    )
    await expect(
      parentFirst.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({ code: 'PARENT_CHILD_LIMIT' })
    await parentHeld.release('disposed')

    const rootActiveFirst = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
    })
    const rootHeld = await rootActiveFirst.authority.prepare(
      request('cold-resume', 'p', 'child-1'),
    )
    await expect(
      rootActiveFirst.authority.prepare(
        request('cold-resume', 'p', 'child-2'),
      ),
    ).rejects.toMatchObject({ code: 'ROOT_ACTIVE_LIMIT' })
    await rootHeld.release('disposed')

    const globalOnly = authorityFixture({
      limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const globalHeld = await globalOnly.authority.prepare(
      request('cold-resume', 'p1', 'child-1'),
    )
    await expect(
      globalOnly.authority.prepare(
        request('cold-resume', 'p2', 'child-2'),
      ),
    ).rejects.toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
    await globalHeld.release('disposed')
  })

  it('does not create a lease when the durable reservation fails', async () => {
    const f = authorityFixture()
    f.ledger.failWrites = true

    await expect(
      f.authority.prepare(request('new-continuable', 'p', 'reserved-child')),
    ).rejects.toMatchObject({ code: 'ADMISSION_STATE_IO' })
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
    expect(f.events.at(-1)).toMatchObject({
      kind: 'denied',
      code: 'ADMISSION_STATE_IO',
    })

    f.ledger.failWrites = false
    const recovered = await f.authority.prepare(request('new-one-shot'))
    expect(f.ledger.writes).toBe(1)
    await recovered.release('disposed')
  })

  it('linearizes concurrent prepares without admitting beyond global capacity', async () => {
    const f = authorityFixture({
      limits: { ...LIMITS, globalActive: 6, perRootActive: 4 },
      parentRoots: { p1: 'r1', p2: 'r2' },
    })

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        f.authority.prepare(
          request('new-one-shot', index % 2 === 0 ? 'p1' : 'p2'),
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
      accepted.map(async ({ value }) => value.release('disposed')),
    )
    expect(f.leases.globalActive).toBe(0)
  })

  it('charges active capacity but no cumulative write for cold resume', async () => {
    const f = authorityFixture()
    const before = f.ledger.writes

    const permit = await f.authority.prepare(
      request('cold-resume', 'p', 'existing-child'),
    )
    expect(f.ledger.writes).toBe(before)
    expect(f.leases.size).toBe(1)
    expect(leaseFor(f.leases, permit)).toMatchObject({
      childSessionId: 'existing-child',
      operation: 'cold-resume',
    })

    await permit.release('completed')
    expect(f.leases.size).toBe(0)
  })

  it('maps a lost process guard to unavailable before root or ledger work', async () => {
    const f = authorityFixture({
      guardFailure: Object.freeze({ reason: 'owner-lost' }),
    })

    await expect(
      f.authority.prepare(request('new-one-shot')),
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

    await expect(f.authority.prepare(invalid)).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
    expect(f.guard.assertHeld).not.toHaveBeenCalled()
    expect(f.roots.resolveCalls).toEqual([])
    expect(f.ledger.trace).toEqual([])
  })

  it('consumes nothing when the official caller cancels before invoking the policy', async () => {
    const f = authorityFixture()
    const controller = new AbortController()
    controller.abort()

    if (!controller.signal.aborted) {
      await f.authority.prepare(request('new-one-shot'))
    }

    expect(f.guard.assertHeld).not.toHaveBeenCalled()
    expect(f.roots.resolveCalls).toEqual([])
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(0)
  })
})

describe('AdmissionPermit binding and release', () => {
  it('rejects a duplicate known child before another cumulative write or active lease', async () => {
    const f = authorityFixture()
    const first = await f.authority.prepare(
      request('new-continuable', 'p', 'reserved-child'),
    )

    await expect(
      f.authority.prepare(
        request('new-continuable', 'p', 'reserved-child'),
      ),
    ).rejects.toMatchObject({
      code: 'ADMISSION_BINDING_CONFLICT',
      observedValue: 1,
      limit: 1,
    })
    expect(f.ledger.writes).toBe(1)
    expect(f.leases.size).toBe(1)

    await first.release('disposed')
  })

  it('allows only one live cold-resume permit for the same existing child', async () => {
    const f = authorityFixture()
    const first = await f.authority.prepare(
      request('cold-resume', 'p', 'existing-child'),
    )

    await expect(
      f.authority.prepare(
        request('cold-resume', 'p', 'existing-child'),
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
    expect(f.ledger.writes).toBe(0)
    expect(f.leases.size).toBe(1)

    await first.release('disposed')
    const resumedAgain = await f.authority.prepare(
      request('cold-resume', 'p', 'existing-child'),
    )
    await resumedAgain.release('completed')
  })

  it('rejects two otherwise valid permits binding the same live child', async () => {
    const f = authorityFixture()
    const first = await f.authority.prepare(request('new-one-shot'))
    const second = await f.authority.prepare(request('new-one-shot'))

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

    await first.release('disposed')
    await second.release('startup-failed')
  })

  it('binds at most once, accepts an identical repeat, and rejects conflicts', async () => {
    const f = authorityFixture()
    const permit = await f.authority.prepare(
      request('new-continuable', 'p', 'reserved-child'),
    )
    const binding = {
      childSessionId: 'reserved-child',
      localParentSessionId: 'p',
    }

    expect(() => permit.bindChild(binding)).not.toThrow()
    expect(() => permit.bindChild(binding)).not.toThrow()
    expect(f.roots.bindings).toHaveLength(1)
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

    await permit.release('disposed')
    expect(
      captureSyncError(() => permit.bindChild(binding)),
    ).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
  })

  it('releases once under duplicate concurrent callbacks without negative counts', async () => {
    const f = authorityFixture()
    const permit = await f.authority.prepare(request('new-one-shot'))

    await Promise.all([
      permit.release('disposed'),
      permit.release('disposed'),
      permit.release('error'),
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
    const permit = await f.authority.prepare(request('new-one-shot'))
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
      f.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({
      code: 'ROOT_TOTAL_LIMIT',
      observedValue: 1,
      limit: 1,
    })
    expect(f.ledger.writes).toBe(1)
  })
})

describe('AdmissionAuthority close and drain', () => {
  it('tombstones new prepares synchronously while existing permits remain releasable', async () => {
    const f = authorityFixture()
    const permit = await f.authority.prepare(request('new-one-shot'))
    const callsBeforeClose = f.guard.assertHeld.mock.calls.length

    f.authority.closeAdmission()

    expect(f.leases.snapshot()[0]).toMatchObject({ phase: 'draining' })
    await expect(
      f.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    expect(f.guard.assertHeld).toHaveBeenCalledTimes(callsBeforeClose)

    await permit.release('disposed')
    await expect(f.authority.drain()).resolves.toBeUndefined()
  })

  it('waits for the final permit and never force-releases it', async () => {
    const f = authorityFixture({
      parentRoots: { p1: 'r1', p2: 'r2' },
    })
    const first = await f.authority.prepare(request('new-one-shot', 'p1'))
    const second = await f.authority.prepare(request('new-one-shot', 'p2'))
    f.authority.closeAdmission()

    let drained = false
    const drain = f.authority.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await first.release('disposed')
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.leases.size).toBe(1)

    await second.release('disposed')
    await drain
    expect(drained).toBe(true)
    expect(f.leases.size).toBe(0)
  })

  it('does not let drain finish ahead of a prepare already inside the serial section', async () => {
    const f = authorityFixture()
    const gate = f.roots.blockNextResolve()
    const preparing = f.authority.prepare(request('new-one-shot'))
    await gate.entered

    f.authority.closeAdmission()
    let drained = false
    const drain = f.authority.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.release()
    const permit = await preparing
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.leases.snapshot()[0]).toMatchObject({ phase: 'draining' })

    await permit.release('disposed')
    await drain
    expect(drained).toBe(true)
  })
})

describe('authority/model trace parity', () => {
  it('matches active and cumulative state across generated prepare, release, and unload sequences', async () => {
    const limits: AdmissionLimits = {
      globalActive: 3,
      perRootActive: 2,
      perRootAdmittedTotal: 5,
      perParentChildren: 3,
    }
    const command = fc.oneof(
      fc.record({
        kind: fc.constant('prepare' as const),
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
              if (next.kind === 'prepare') {
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
                  actualPermit = await f.authority.prepare(actualRequest)
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
                    await held.actual.release('disposed')
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
                await actual.release('disposed').catch(() => undefined)
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
      f.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({ code: 'ADMISSION_STATE_IO' })
    expect(f.ledger.writes).toBe(1)
    expect(f.leases.size).toBe(0)
    expect(f.diagnostics).toEqual(['post-commit-lease-insertion-failed'])

    await expect(
      f.authority.prepare(request('new-one-shot')),
    ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    await expect(f.authority.drain()).resolves.toBeUndefined()
  })
})
