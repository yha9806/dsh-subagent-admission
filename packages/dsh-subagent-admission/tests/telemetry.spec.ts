import { describe, expect, it, vi } from 'vitest'

import {
  MAX_HISTORY_EVENTS,
  SNAPSHOT_SCHEMA_VERSION,
  type AdmissionLimits,
  type AdmissionMode,
} from '../src/types.js'
import {
  AdmissionTelemetry,
  type AdmissionTelemetryEventInput,
  type AdmissionTelemetryOptions,
  type TelemetryLeaseInput,
  type TelemetryRootLedgerSnapshot,
} from '../src/host/telemetry.js'

const LIMITS: AdmissionLimits = {
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
}

interface MutableTelemetryState {
  status: { mode: AdmissionMode; enforced: boolean; reason: string | null }
  leases: TelemetryLeaseInput[]
  ledgers: Map<string, TelemetryRootLedgerSnapshot>
  roots: Map<string, string>
  now: number
}

function telemetryFixture(
  overrides: Partial<AdmissionTelemetryOptions> = {},
) {
  const state: MutableTelemetryState = {
    status: { mode: 'strict', enforced: true, reason: null },
    leases: [],
    ledgers: new Map(),
    roots: new Map([
      ['root', 'root'],
      ['parent', 'root'],
    ]),
    now: 1_000,
  }
  const options = {
    epoch: 'epoch-test',
    limits: LIMITS,
    readStatus: () => state.status,
    readLeases: () => state.leases,
    readRootLedger: (rootId: string) => state.ledgers.get(rootId),
    resolveRoot: (sessionId: string) => state.roots.get(sessionId) ?? null,
    clock: { now: () => state.now },
    ...overrides,
  } satisfies AdmissionTelemetryOptions
  return {
    telemetry: new AdmissionTelemetry(options),
    state,
  }
}

function event(
  index: number,
  overrides: Partial<AdmissionTelemetryEventInput> = {},
): AdmissionTelemetryEventInput {
  return {
    kind: 'accepted',
    time: index,
    requestId: `request-${String(index)}`,
    operation: 'new-one-shot',
    rootId: 'root',
    parentSessionId: 'parent',
    childSessionId: `child-${String(index)}`,
    code: null,
    duplicate: false,
    ...overrides,
  }
}

describe('AdmissionTelemetry snapshots', () => {
  it('keeps the newest 200 events and reports dropped global history', () => {
    const { telemetry } = telemetryFixture()

    for (let index = 0; index < 205; index += 1) {
      telemetry.record(event(index))
    }

    const snapshot = telemetry.snapshot('root')
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
    expect(snapshot.enforced).toBe(true)
    expect(snapshot.epoch).toBe('epoch-test')
    expect(snapshot.revision).toBe(205)
    expect(snapshot.history).toHaveLength(MAX_HISTORY_EVENTS)
    expect(snapshot.droppedHistory).toBe(5)
    expect(snapshot.history[0]).toMatchObject({ requestId: 'request-5' })
    expect(snapshot.history.at(-1)).toMatchObject({
      requestId: 'request-204',
    })
  })

  it('scopes ledger, active lease, and history views while retaining global active usage', () => {
    const { telemetry, state } = telemetryFixture()
    state.roots.set('parent-1', 'root-1')
    state.roots.set('parent-2', 'root-2')
    state.leases.push(
      {
        permitId: 'permit-1',
        requestId: 'request-1',
        operation: 'new-one-shot',
        rootSessionId: 'root-1',
        parentSessionId: 'parent-1',
        expectedChildSessionId: null,
        childSessionId: null,
        admittedAt: 10,
        phase: 'active',
        mode: 'strict',
      },
      {
        permitId: 'permit-2',
        requestId: 'request-2',
        operation: 'cold-resume',
        rootSessionId: 'root-2',
        parentSessionId: 'parent-2',
        expectedChildSessionId: 'child-2',
        childSessionId: 'child-2',
        admittedAt: 20,
        phase: 'draining',
        mode: 'strict',
      },
    )
    state.ledgers.set('root-1', {
      rootSessionId: 'root-1',
      admittedTotal: 7,
      admittedChildrenByParent: { 'parent-1': 3 },
    })
    state.ledgers.set('root-2', {
      rootSessionId: 'root-2',
      admittedTotal: 9,
      admittedChildrenByParent: { 'parent-2': 4 },
    })
    telemetry.record(
      event(1, {
        rootId: 'root-1',
        parentSessionId: 'parent-1',
        childSessionId: null,
      }),
    )
    telemetry.record(
      event(2, {
        rootId: 'root-2',
        parentSessionId: 'parent-2',
        childSessionId: 'child-2',
      }),
    )

    const snapshot = telemetry.snapshot('parent-1')
    expect(snapshot.requestedRootId).toBe('root-1')
    expect(snapshot.usage).toEqual({
      globalActive: 2,
      rootActive: 1,
      rootAdmittedTotal: 7,
      parentChildren: 3,
    })
    expect(snapshot.leases).toEqual([
      {
        childSessionId: null,
        parentSessionId: 'parent-1',
        rootId: 'root-1',
        operation: 'new-one-shot',
        mode: 'strict',
        admittedAt: new Date(10).toISOString(),
        phase: 'active',
      },
    ])
    expect(snapshot.history).toHaveLength(1)
    expect(snapshot.history[0]).toMatchObject({ rootId: 'root-1' })
  })

  it('uses state-only bound events to advance revision and root bindings without fabricating another acceptance', () => {
    const { telemetry, state } = telemetryFixture()
    state.leases.push({
      permitId: 'permit',
      requestId: 'request',
      operation: 'new-one-shot',
      rootSessionId: 'root',
      parentSessionId: 'parent',
      expectedChildSessionId: null,
      childSessionId: 'published-child',
      admittedAt: 10,
      phase: 'active',
      mode: 'strict',
    })

    telemetry.record(
      event(1, {
        kind: 'bound',
        requestId: 'request',
        childSessionId: 'published-child',
      }),
    )

    const snapshot = telemetry.snapshot('published-child')
    expect(snapshot.revision).toBe(1)
    expect(snapshot.requestedRootId).toBe('root')
    expect(snapshot.leases).toHaveLength(1)
    expect(snapshot.history).toEqual([])
  })

  it('maps duplicate release callbacks to protocol diagnostics rather than extra release transitions', () => {
    const { telemetry } = telemetryFixture()

    telemetry.record(
      event(1, {
        kind: 'released',
        childSessionId: 'child',
        duplicate: false,
      }),
    )
    telemetry.record(
      event(2, {
        kind: 'released',
        childSessionId: 'child',
        duplicate: true,
      }),
    )

    expect(telemetry.snapshot('root').history).toEqual([
      expect.objectContaining({ kind: 'released', code: null }),
      expect.objectContaining({
        kind: 'protocol',
        code: 'DUPLICATE_RELEASE',
      }),
    ])
  })

  it('preserves the first session-root projection and fails the view closed on conflicts', () => {
    const { telemetry } = telemetryFixture()
    telemetry.record(
      event(1, {
        rootId: 'root-1',
        parentSessionId: 'parent-1',
        childSessionId: 'shared-child',
      }),
    )
    telemetry.record(
      event(2, {
        rootId: 'root-2',
        parentSessionId: 'parent-2',
        childSessionId: 'shared-child',
      }),
    )

    expect(telemetry.snapshot('shared-child')).toMatchObject({
      requestedRootId: 'root-1',
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-binding-conflict',
    })
  })

  it('drops sensitive extra fields and returns deeply frozen replacement data', () => {
    const { telemetry, state } = telemetryFixture()
    state.status = {
      mode: 'unavailable',
      enforced: false,
      reason: 'bootstrap-unsafe',
    }
    state.leases.push({
      permitId: 'permit',
      requestId: 'request',
      operation: 'new-one-shot',
      rootSessionId: 'root',
      parentSessionId: 'parent',
      expectedChildSessionId: null,
      childSessionId: null,
      admittedAt: 10,
      phase: 'active',
      mode: 'strict',
      prompt: 'PRIVATE_PROMPT',
      credentials: 'PRIVATE_CREDENTIALS',
    } as TelemetryLeaseInput)
    state.ledgers.set('root', {
      rootSessionId: 'root',
      admittedTotal: 1,
      admittedChildrenByParent: { parent: 1 },
      modelOutput: 'PRIVATE_OUTPUT',
    } as TelemetryRootLedgerSnapshot)
    telemetry.record({
      ...event(1),
      messages: ['PRIVATE_MESSAGE'],
      toolArguments: { secret: true },
      stack: 'PRIVATE_STACK',
    } as AdmissionTelemetryEventInput)
    telemetry.record(
      event(2, {
        kind: 'denied',
        rootId: null,
        parentSessionId: 'PRIVATE_PARENT_ID',
        childSessionId: 'PRIVATE_CHILD_ID',
        requestId: 'PRIVATE_REQUEST_ID',
        code: 'ADMISSION_CLOSED',
      }),
    )

    const snapshot = telemetry.snapshot('root')
    const serialized = JSON.stringify(snapshot)
    for (const forbidden of [
      'prompt',
      'messages',
      'toolArguments',
      'modelOutput',
      'credentials',
      'stack',
      'PRIVATE_',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.limits)).toBe(true)
    expect(Object.isFrozen(snapshot.usage)).toBe(true)
    expect(Object.isFrozen(snapshot.leases)).toBe(true)
    expect(Object.isFrozen(snapshot.leases[0])).toBe(true)
    expect(Object.isFrozen(snapshot.history)).toBe(true)
    expect(Object.isFrozen(snapshot.history[0])).toBe(true)
  })

  it('keeps snapshots available when non-authoritative readers fail', () => {
    const telemetry = new AdmissionTelemetry({
      epoch: 'epoch-reader-failure',
      limits: LIMITS,
      readStatus: () => {
        throw new Error('status reader failed')
      },
      readLeases: () => {
        throw new Error('lease reader failed')
      },
      readRootLedger: () => {
        throw new Error('ledger reader failed')
      },
      resolveRoot: () => {
        throw new Error('root reader failed')
      },
    })

    expect(telemetry.snapshot('root')).toMatchObject({
      epoch: 'epoch-reader-failure',
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-reader-unavailable',
      requestedRootId: null,
      usage: {
        globalActive: 0,
        rootActive: 0,
        rootAdmittedTotal: 0,
        parentChildren: 0,
      },
      leases: [],
    })
  })

  it('fails closed instead of claiming enforcement for an incoherent mode', () => {
    const telemetry = new AdmissionTelemetry({
      epoch: 'epoch-incoherent-status',
      limits: LIMITS,
      readStatus: () => ({
        mode: 'audit',
        enforced: true,
        reason: null,
      }),
      readLeases: () => [],
      readRootLedger: () => undefined,
    })

    expect(telemetry.snapshot('root')).toMatchObject({
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-reader-unavailable',
    })
  })

  it('fails the view closed when a read-only ledger snapshot names the wrong root', () => {
    const telemetry = new AdmissionTelemetry({
      epoch: 'epoch-wrong-ledger-root',
      limits: LIMITS,
      readStatus: () => ({ mode: 'strict', enforced: true, reason: null }),
      readLeases: () => [],
      resolveRoot: () => 'expected-root',
      readRootLedger: () => ({
        rootSessionId: 'other-root',
        admittedTotal: 7,
        admittedChildrenByParent: {},
      }),
    })

    expect(telemetry.snapshot('parent')).toMatchObject({
      requestedRootId: 'expected-root',
      mode: 'unavailable',
      enforced: false,
      reason: 'telemetry-reader-unavailable',
      usage: { rootAdmittedTotal: 0 },
    })
  })

  it('uses a fresh process epoch by default and preserves an injected epoch', () => {
    const first = new AdmissionTelemetry({
      limits: LIMITS,
      readStatus: () => ({ mode: 'audit', enforced: false, reason: null }),
      readLeases: () => [],
      readRootLedger: () => undefined,
    })
    const second = new AdmissionTelemetry({
      limits: LIMITS,
      readStatus: () => ({ mode: 'audit', enforced: false, reason: null }),
      readLeases: () => [],
      readRootLedger: () => undefined,
    })

    expect(first.epoch).not.toBe(second.epoch)
    expect(telemetryFixture().telemetry.epoch).toBe('epoch-test')
  })
})

describe('AdmissionTelemetry watch', () => {
  it('returns a full snapshot immediately for epoch or revision mismatch without installing listeners', async () => {
    const { telemetry } = telemetryFixture()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')

    await expect(
      telemetry.watch(
        {
          sessionId: 'root',
          epoch: 'other-epoch',
          revision: 0,
          timeoutMs: 30_000,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ epoch: 'epoch-test', revision: 0 })
    await expect(
      telemetry.watch(
        {
          sessionId: 'root',
          epoch: 'epoch-test',
          revision: 99,
          timeoutMs: 30_000,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ epoch: 'epoch-test', revision: 0 })
    expect(add).not.toHaveBeenCalled()
  })

  it('wakes every matching watcher on one revision and returns complete replacements', async () => {
    vi.useFakeTimers()
    try {
      const { telemetry } = telemetryFixture()
      const firstController = new AbortController()
      const secondController = new AbortController()
      const first = telemetry.watch(
        {
          sessionId: 'root',
          epoch: telemetry.epoch,
          revision: 0,
          timeoutMs: 30_000,
        },
        firstController.signal,
      )
      const second = telemetry.watch(
        {
          sessionId: 'parent',
          epoch: telemetry.epoch,
          revision: 0,
          timeoutMs: 30_000,
        },
        secondController.signal,
      )
      expect(vi.getTimerCount()).toBe(2)

      telemetry.record(event(1))

      await expect(first).resolves.toMatchObject({ revision: 1 })
      await expect(second).resolves.toMatchObject({ revision: 1 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps timeout to 0..30 seconds and removes timers and abort listeners', async () => {
    vi.useFakeTimers()
    try {
      const { telemetry } = telemetryFixture()
      const immediateController = new AbortController()
      await expect(
        telemetry.watch(
          {
            sessionId: 'root',
            epoch: telemetry.epoch,
            revision: 0,
            timeoutMs: -100,
          },
          immediateController.signal,
        ),
      ).resolves.toMatchObject({ revision: 0 })
      expect(vi.getTimerCount()).toBe(0)

      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      let settled = false
      const waiting = telemetry
        .watch(
          {
            sessionId: 'root',
            epoch: telemetry.epoch,
            revision: 0,
            timeoutMs: 99_999,
          },
          controller.signal,
        )
        .then((snapshot) => {
          settled = true
          return snapshot
        })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(waiting).resolves.toMatchObject({ revision: 0 })
      expect(remove).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects already-aborted and in-flight aborts with a sanitized AbortError and no leaks', async () => {
    vi.useFakeTimers()
    try {
      const { telemetry } = telemetryFixture()
      const already = new AbortController()
      already.abort(new Error('PRIVATE_ABORT_REASON'))
      await expect(
        telemetry.watch(
          {
            sessionId: 'root',
            epoch: telemetry.epoch,
            revision: 0,
            timeoutMs: 30_000,
          },
          already.signal,
        ),
      ).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Snapshot watch aborted',
      })

      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const waiting = telemetry.watch(
        {
          sessionId: 'root',
          epoch: telemetry.epoch,
          revision: 0,
          timeoutMs: 30_000,
        },
        controller.signal,
      )
      expect(vi.getTimerCount()).toBe(1)
      controller.abort(new Error('PRIVATE_ABORT_REASON'))
      await expect(waiting).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Snapshot watch aborted',
      })
      expect(remove).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(JSON.stringify(await waiting.catch((error: unknown) => error))).not
        .toContain('PRIVATE_ABORT_REASON')
    } finally {
      vi.useRealTimers()
    }
  })
})
