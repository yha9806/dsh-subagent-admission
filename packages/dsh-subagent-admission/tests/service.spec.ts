import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import type { AdmissionLimits } from '../src/types.js'
import type { ReserveNewInput } from '../src/host/ledger.js'
import type { RootLedgerRow } from '../src/host/ledger-spec.js'
import type { SubagentAdmissionPolicyV1 } from '../src/host/seam-v1.js'
import type {
  CompatibilityBaseline,
  CompatibilityBootstrap,
  CompatibilityRuntime,
} from '../src/host/compatibility.js'
import { selectAdmissionMode } from '../src/host/compatibility.js'
import { AdmissionAuthority } from '../src/host/authority.js'
import { ActiveLeaseRegistry } from '../src/host/leases.js'
import {
  createSubagentAdmissionService,
  SubagentAdmissionService,
} from '../src/host/service.js'

const LIMITS: AdmissionLimits = Object.freeze({
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
})

const SAFE_BOOTSTRAP: CompatibilityBootstrap = Object.freeze({
  safe: true,
  reason: null,
})

function targetBaseline(protocolVersion = 1): CompatibilityBaseline {
  return Object.freeze({
    schemaVersion: 1,
    strictTargets: Object.freeze([
      Object.freeze({
        sourceCommit: 'a'.repeat(40),
        sourcePackageVersion: '0.1.0-rc.test',
        protocolVersion,
        patchSha256: 'b'.repeat(64),
        verificationCommand: 'corepack pnpm test:seam',
      }),
    ]),
  })
}

function emptyBaseline(): CompatibilityBaseline {
  return Object.freeze({ schemaVersion: 1, strictTargets: Object.freeze([]) })
}

function runtime(protocolVersion?: number): CompatibilityRuntime {
  const value: CompatibilityRuntime = {
    packageVersion: '0.1.0-rc.test',
    registerAdmissionPolicy: (): (() => void) => (): void => {},
    ...(protocolVersion === undefined
      ? {}
      : { admissionProtocolVersion: protocolVersion }),
  }
  return Object.freeze(value)
}

interface TestSessionHeader {
  readonly id: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

interface TestSession {
  readonly id: string
  readonly header: TestSessionHeader
}

interface RuntimeRegistrationState {
  attempts: number
  active: SubagentAdmissionPolicyV1 | undefined
  unregistrations: number
}

interface ResourceState {
  guardAcquisitions: number
  guardReleases: number
  ledgerOpens: number
  ledgerCloses: number
}

function provide(ctx: Context, name: string, value: unknown): void {
  ;(ctx as unknown as {
    provide(serviceName: string, service: unknown): () => void
  }).provide(name, value)
}

function hostContext(options: {
  readonly runtime?: object
  readonly live?: readonly TestSession[]
  readonly persisted?: readonly TestSessionHeader[]
  readonly includeStorage?: boolean
}): Context {
  const ctx = new Context()
  const live = [...(options.live ?? [])]
  const persisted = [...(options.persisted ?? [])]
  provide(ctx, 'subagents', options.runtime)
  provide(ctx, 'sessions', {
    get: (id: string): TestSession | undefined =>
      live.find((session) => session.id === id),
    list: (): TestSession[] => [...live],
  })
  provide(ctx, 'sessionPersistence', {
    list: async (): Promise<TestSessionHeader[]> => [...persisted],
    inspect: async (
      id: string,
    ): Promise<{ readonly meta: TestSessionHeader } | undefined> => {
      const header = persisted.find((candidate) => candidate.id === id)
      return header === undefined ? undefined : { meta: header }
    },
  })
  if (options.includeStorage ?? true) {
    provide(ctx, 'storageDomain', {
      open: (): never => {
        throw new Error('injected test ledger must intercept storage open')
      },
    })
  }
  return ctx
}

function testRuntime(
  state: RuntimeRegistrationState,
  protocolVersion = 1,
): object {
  return {
    admissionProtocolVersion: protocolVersion,
    registerAdmissionPolicy: (
      policy: SubagentAdmissionPolicyV1,
    ): (() => void) => {
      state.attempts += 1
      if (state.active !== undefined) {
        throw new Error('policy already registered')
      }
      state.active = policy
      return (): void => {
        state.unregistrations += 1
        state.active = undefined
      }
    },
  }
}

function strictResources(state: ResourceState): {
  readonly acquireGuard: () => Promise<{
    assertHeld(): Promise<void>
    release(): Promise<void>
  }>
  readonly openLedger: () => Promise<{
    read(rootId: string): Promise<Readonly<RootLedgerRow> | undefined>
    reserveNew(
      input: ReserveNewInput,
      assertActiveCapacity: () => void,
    ): Promise<Readonly<RootLedgerRow>>
    close(): Promise<void>
  }>
} {
  const rows = new Map<string, Readonly<RootLedgerRow>>()
  return {
    acquireGuard: async () => {
      state.guardAcquisitions += 1
      return {
        assertHeld: async (): Promise<void> => {},
        release: async (): Promise<void> => {
          state.guardReleases += 1
        },
      }
    },
    openLedger: async () => {
      state.ledgerOpens += 1
      return {
        read: async (rootId) => rows.get(rootId),
        reserveNew: async (input, assertActiveCapacity) => {
          assertActiveCapacity()
          const previous = rows.get(input.rootSessionId)
          const admittedChildrenByParent = Object.freeze({
            ...previous?.admittedChildrenByParent,
            [input.parentSessionId]:
              (previous?.admittedChildrenByParent[input.parentSessionId] ?? 0) + 1,
          })
          const row: Readonly<RootLedgerRow> = Object.freeze({
            schemaVersion: 1,
            rootSessionId: input.rootSessionId,
            coverageStartedAt: previous?.coverageStartedAt ?? input.now,
            admittedTotal: (previous?.admittedTotal ?? 0) + 1,
            admittedChildrenByParent,
            revision: (previous?.revision ?? 0) + 1,
          })
          rows.set(input.rootSessionId, row)
          return row
        },
        close: async (): Promise<void> => {
          state.ledgerCloses += 1
        },
      }
    },
  }
}

function registrationState(): RuntimeRegistrationState {
  return {
    attempts: 0,
    active: undefined,
    unregistrations: 0,
  }
}

function resourceState(): ResourceState {
  return {
    guardAcquisitions: 0,
    guardReleases: 0,
    ledgerOpens: 0,
    ledgerCloses: 0,
  }
}

describe('host compatibility mode selection', () => {
  it.each([
    {
      configured: 'audit' as const,
      candidate: Object.freeze({ packageVersion: '0.1.0-rc.test' }),
      baseline: emptyBaseline(),
      expected: 'audit',
    },
    {
      configured: 'strict' as const,
      candidate: Object.freeze({ packageVersion: '0.1.0-rc.test' }),
      baseline: emptyBaseline(),
      expected: 'unavailable',
    },
    {
      configured: 'strict' as const,
      candidate: runtime(2),
      baseline: targetBaseline(1),
      expected: 'unavailable',
    },
    {
      configured: 'strict' as const,
      candidate: runtime(1),
      baseline: targetBaseline(1),
      expected: 'strict',
    },
  ])(
    'selects $expected for configured $configured mode',
    ({ configured, candidate, baseline, expected }) => {
      const selected = selectAdmissionMode({
        configured,
        runtime: candidate,
        baseline,
        storageDomainAvailable: true,
        bootstrap: SAFE_BOOTSTRAP,
        ownershipGuardHeld: true,
      })
      expect(selected.mode).toBe(expected)
      expect(selected.enforced).toBe(expected === 'strict')
    },
  )

  it('never registers a policy for configured Audit even when a seam exists', () => {
    let registrations = 0
    const selected = selectAdmissionMode({
      configured: 'audit',
      runtime: Object.freeze({
        ...runtime(1),
        registerAdmissionPolicy: (): (() => void) => {
          registrations += 1
          return (): void => {}
        },
      }),
      baseline: targetBaseline(1),
      storageDomainAvailable: true,
      bootstrap: SAFE_BOOTSTRAP,
      ownershipGuardHeld: true,
    })
    expect(selected).toMatchObject({ mode: 'audit', enforced: false })
    expect(registrations).toBe(0)
  })

  it.each([
    {
      storageDomainAvailable: false,
      bootstrap: SAFE_BOOTSTRAP,
      ownershipGuardHeld: true,
      reason: 'storage-domain-unavailable',
    },
    {
      storageDomainAvailable: true,
      bootstrap: Object.freeze({ safe: false, reason: 'lineage-unsafe' }),
      ownershipGuardHeld: true,
      reason: 'lineage-unsafe',
    },
    {
      storageDomainAvailable: true,
      bootstrap: SAFE_BOOTSTRAP,
      ownershipGuardHeld: false,
      reason: 'ownership-guard-unavailable',
    },
  ])('fails Strict closed when $reason', (facts) => {
    expect(
      selectAdmissionMode({
        configured: 'strict',
        runtime: runtime(1),
        baseline: targetBaseline(1),
        ...facts,
      }),
    ).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: facts.reason,
    })
  })
})

describe('host service composition', () => {
  it('keeps production Strict unavailable before any target is verified', async () => {
    const registration = registrationState()
    const resources = resourceState()
    const ctx = hostContext({
      runtime: testRuntime(registration),
      persisted: [{ id: 'root' }],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'strict', ownershipPath: '/tmp/dsh-admission-owner' },
      {
        baseline: emptyBaseline(),
        runtimePackageVersion: '0.1.0-rc.test',
        ...strictResources(resources),
        epoch: 'strict-empty-targets',
        clock: { now: () => 1 },
      },
    )

    expect(service.currentSnapshot('root')).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: 'unsupported-runtime-build',
    })
    expect(registration).toMatchObject({ attempts: 0, unregistrations: 0 })
    expect(resources).toEqual(resourceState())
    await service.dispose()
  })

  it('composes Strict only after bootstrap and unregisters before cleanup', async () => {
    const registration = registrationState()
    const resources = resourceState()
    const ctx = hostContext({
      runtime: testRuntime(registration),
      persisted: [{ id: 'root' }],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'strict', ownershipPath: '/tmp/dsh-admission-owner' },
      {
        baseline: targetBaseline(),
        runtimePackageVersion: '0.1.0-rc.test',
        ...strictResources(resources),
        epoch: 'strict-ready',
        clock: { now: () => 2 },
      },
    )

    expect(service.currentSnapshot('root')).toMatchObject({
      mode: 'strict',
      enforced: true,
      reason: null,
    })
    expect(registration.attempts).toBe(1)
    expect(registration.active?.protocolVersion).toBe(1)
    expect(resources).toMatchObject({
      guardAcquisitions: 1,
      guardReleases: 0,
      ledgerOpens: 1,
      ledgerCloses: 0,
    })

    await service.dispose()
    expect(registration).toMatchObject({
      attempts: 1,
      active: undefined,
      unregistrations: 1,
    })
    expect(resources).toMatchObject({
      guardReleases: 1,
      ledgerCloses: 1,
    })
  })

  it('rejects a protocol mismatch before acquiring authoritative resources', async () => {
    const registration = registrationState()
    const resources = resourceState()
    const ctx = hostContext({
      runtime: testRuntime(registration, 2),
      persisted: [{ id: 'root' }],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'strict', ownershipPath: '/tmp/dsh-admission-owner' },
      {
        baseline: targetBaseline(1),
        runtimePackageVersion: '0.1.0-rc.test',
        ...strictResources(resources),
        epoch: 'strict-protocol-mismatch',
        clock: { now: () => 3 },
      },
    )

    expect(service.currentSnapshot('root')).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: 'unsupported-admission-protocol',
    })
    expect(registration).toMatchObject({ attempts: 0, unregistrations: 0 })
    expect(resources).toEqual(resourceState())
    await service.dispose()
  })

  it('cleans guard and ledger when policy registration fails', async () => {
    const registration = registrationState()
    const resources = resourceState()
    const ctx = hostContext({
      runtime: {
        admissionProtocolVersion: 1,
        registerAdmissionPolicy: (): never => {
          registration.attempts += 1
          throw new Error('registration rejected')
        },
      },
      persisted: [{ id: 'root' }],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'strict', ownershipPath: '/tmp/dsh-admission-owner' },
      {
        baseline: targetBaseline(),
        runtimePackageVersion: '0.1.0-rc.test',
        ...strictResources(resources),
        epoch: 'strict-registration-failed',
        clock: { now: () => 4 },
      },
    )

    expect(service.currentSnapshot('root')).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: 'policy-registration-failed',
    })
    expect(registration).toMatchObject({
      attempts: 1,
      active: undefined,
      unregistrations: 0,
    })
    expect(resources).toMatchObject({
      guardAcquisitions: 1,
      guardReleases: 1,
      ledgerOpens: 1,
      ledgerCloses: 1,
    })
    await service.dispose()
  })

  it('rejects a dirty live bootstrap without registering a policy', async () => {
    const registration = registrationState()
    const resources = resourceState()
    const ctx = hostContext({
      runtime: testRuntime(registration),
      live: [
        { id: 'root', header: { id: 'root' } },
        {
          id: 'child',
          header: {
            id: 'child',
            parentSession: 'root',
            origin: 'subagent',
          },
        },
      ],
      persisted: [{ id: 'root' }],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'strict', ownershipPath: '/tmp/dsh-admission-owner' },
      {
        baseline: targetBaseline(),
        runtimePackageVersion: '0.1.0-rc.test',
        ...strictResources(resources),
        epoch: 'strict-dirty-bootstrap',
        clock: { now: () => 5 },
      },
    )

    expect(service.currentSnapshot('root')).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: 'bootstrap-live-subagent-present',
    })
    expect(registration).toMatchObject({ attempts: 0, unregistrations: 0 })
    expect(resources).toMatchObject({
      guardAcquisitions: 1,
      guardReleases: 1,
      ledgerOpens: 1,
      ledgerCloses: 1,
    })
    await service.dispose()
  })

  it('observes Audit lifecycle edges without enforcing or inventing quota truth', async () => {
    const registration = registrationState()
    const ctx = hostContext({
      runtime: testRuntime(registration),
      live: [
        { id: 'root', header: { id: 'root' } },
        {
          id: 'child',
          header: { id: 'child', parentSession: 'root', origin: 'subagent' },
        },
      ],
    })
    const service = await createSubagentAdmissionService(
      ctx,
      { mode: 'audit' },
      {
        baseline: targetBaseline(),
        runtimePackageVersion: '0.1.0-rc.test',
        epoch: 'audit-observer',
        clock: { now: () => 6 },
      },
    )
    const emit = (ctx as unknown as {
      emit(name: string, info: unknown): void
    }).emit.bind(ctx)
    emit('subagent/start', {
      runId: 'run-1',
      provider: 'fake',
      id: 'child',
      local: true,
    })
    emit('subagent/end', {
      runId: 'run-1',
      provider: 'fake',
      id: 'child',
      local: true,
      stopReason: 'completed',
    })

    const snapshot = service.currentSnapshot('child')
    expect(snapshot).toMatchObject({
      requestedRootId: 'root',
      mode: 'audit',
      enforced: false,
      usage: {
        globalActive: 0,
        rootActive: 0,
        rootAdmittedTotal: 0,
        parentChildren: 0,
      },
      leases: [],
    })
    expect(snapshot.history.slice(-2)).toMatchObject([
      { kind: 'accepted', operation: null, rootId: 'root' },
      { kind: 'released', operation: null, rootId: 'root' },
    ])
    expect(registration).toMatchObject({ attempts: 0, unregistrations: 0 })
    await service.dispose()
  })
})

describe('SubagentAdmissionService teardown', () => {
  it('tombstones admission before draining storage and the ownership guard', async () => {
    const leases = new ActiveLeaseRegistry()
    const authority = new AdmissionAuthority({
      limits: LIMITS,
      policyEpoch: 'epoch-test',
      roots: {
        resolve: async (sessionId) => ({
          rootSessionId: 'root',
          lineage: Object.freeze([sessionId, 'root']),
        }),
        bindChild: (): void => {},
      },
      ledger: {
        reserveNew: async (_input, assertActiveCapacity): Promise<void> => {
          assertActiveCapacity()
        },
      },
      guard: { assertHeld: async (): Promise<void> => {} },
      leases,
      clock: { now: (): number => 1 },
    })
    const order: string[] = []
    const service = new SubagentAdmissionService(new Context(), {
      authority,
      telemetry: {
        snapshot: () => {
          throw new Error('not used')
        },
        watch: async () => {
          throw new Error('not used')
        },
      },
      unregisterPolicy: (): void => {
        order.push('unregister-policy')
      },
      closeLedger: async (): Promise<void> => {
        order.push('close-ledger')
      },
      releaseGuard: async (): Promise<void> => {
        order.push('release-guard')
      },
    })

    const permit = await authority.prepare({
      requestId: 'request-1',
      operation: 'new-one-shot',
      provider: 'fake',
      parentSessionId: 'parent',
    })
    const disposing = service.dispose()

    await expect(
      authority.prepare({
        requestId: 'request-2',
        operation: 'new-one-shot',
        provider: 'fake',
        parentSessionId: 'parent',
      }),
    ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    expect(order).toEqual(['unregister-policy'])

    await permit.release('disposed')
    await disposing
    expect(order).toEqual([
      'unregister-policy',
      'close-ledger',
      'release-guard',
    ])
  })
})
