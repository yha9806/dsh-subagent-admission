import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import {
  AdmissionSnapshotController,
  RETRY_BACKOFF_MS,
  WATCH_TIMEOUT_MS,
} from '../src/client/controller.ts'
import type { AdmissionSnapshotRemote } from '../src/client/controller.ts'
import { apply, inject as clientInject } from '../src/client/index.ts'
import type { AdmissionSnapshot } from '../src/types.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function success(value: AdmissionSnapshot): RemoteResult<AdmissionSnapshot> {
  return { ok: true, value }
}

function failure(code = 'REMOTE_UNAVAILABLE'): RemoteResult<AdmissionSnapshot> {
  return {
    ok: false,
    error: { code, message: 'temporary failure', details: {} },
  }
}

function snapshot(overrides: Partial<AdmissionSnapshot> = {}): AdmissionSnapshot {
  return {
    schemaVersion: 1,
    time: '2026-08-14T00:00:00.000Z',
    epoch: 'epoch-a',
    revision: 0,
    requestedSessionId: 'root',
    requestedRootId: 'root',
    mode: 'strict',
    enforced: true,
    reason: null,
    limits: {
      globalActive: 6,
      perRootActive: 4,
      perRootAdmittedTotal: 24,
      perParentChildren: 8,
    },
    usage: {
      globalActive: 0,
      rootActive: 0,
      rootAdmittedTotal: 0,
      parentChildren: 0,
    },
    leases: [],
    history: [],
    droppedHistory: 0,
    ...overrides,
  }
}

function heldWatch(): {
  readonly call: AdmissionSnapshotRemote['watch']
  readonly signal: () => AbortSignal | undefined
  readonly settlement: Deferred<RemoteResult<AdmissionSnapshot>>
} {
  const settlement = deferred<RemoteResult<AdmissionSnapshot>>()
  let observedSignal: AbortSignal | undefined
  return {
    call: async (_request, signal) => {
      observedSignal = signal
      return settlement.promise
    },
    signal: () => observedSignal,
    settlement,
  }
}

async function flushPromises(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AdmissionSnapshotController', () => {
  it('replaces full snapshots and accepts an epoch reset without delta merging', async () => {
    const first = snapshot({
      epoch: 'epoch-a',
      revision: 4,
      usage: {
        globalActive: 3,
        rootActive: 2,
        rootAdmittedTotal: 9,
        parentChildren: 1,
      },
      leases: [{
        childSessionId: 'child-a',
        parentSessionId: 'root',
        rootId: 'root',
        operation: 'new-one-shot',
        mode: 'strict',
        admittedAt: '2026-08-14T00:00:00.000Z',
        phase: 'active',
      }],
    })
    const reset = snapshot({
      time: '2026-08-14T00:00:01.000Z',
      epoch: 'epoch-b',
      revision: 0,
      requestedRootId: null,
      mode: 'unavailable',
      enforced: false,
      reason: 'runtime-restarted',
    })
    const held = heldWatch()
    const get = vi.fn<AdmissionSnapshotRemote['get']>(async () => success(first))
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
      .mockResolvedValueOnce(success(reset))
      .mockImplementation(held.call)
    const controller = new AdmissionSnapshotController({ get, watch })

    controller.start('root')
    await vi.waitFor(() => expect(controller.getSnapshot()).toBe(reset))

    expect(watch).toHaveBeenNthCalledWith(1, {
      sessionId: 'root',
      epoch: 'epoch-a',
      revision: 4,
      timeoutMs: WATCH_TIMEOUT_MS,
    }, expect.any(AbortSignal))
    expect(controller.getSnapshot()?.leases).toEqual([])
    expect(controller.getSnapshot()?.usage.rootAdmittedTotal).toBe(0)

    controller.stop()
  })

  it('aborts the old watch and ignores late responses across a session switch', async () => {
    const alpha = snapshot({ requestedSessionId: 'alpha', requestedRootId: 'alpha' })
    const beta = snapshot({
      epoch: 'epoch-beta',
      revision: 2,
      requestedSessionId: 'beta',
      requestedRootId: 'beta',
    })
    const lateAlpha = snapshot({
      epoch: 'epoch-alpha-late',
      revision: 99,
      requestedSessionId: 'alpha',
      requestedRootId: 'alpha',
    })
    const alphaWatch = heldWatch()
    const betaWatch = heldWatch()
    const get = vi.fn<AdmissionSnapshotRemote['get']>(async ({ sessionId }) =>
      success(sessionId === 'alpha' ? alpha : beta))
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
      .mockImplementationOnce(alphaWatch.call)
      .mockImplementation(betaWatch.call)
    const controller = new AdmissionSnapshotController({ get, watch })
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    controller.start('alpha')
    await vi.waitFor(() => expect(alphaWatch.signal()).toBeDefined())
    controller.start('beta')
    expect(alphaWatch.signal()?.aborted).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot()).toBe(beta))

    alphaWatch.settlement.resolve(success(lateAlpha))
    await flushPromises()
    expect(controller.getSnapshot()).toBe(beta)

    controller.start('beta')
    await flushPromises()
    expect(get).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalled()

    controller.stop()
    expect(betaWatch.signal()?.aborted).toBe(true)
    expect(controller.getSnapshot()).toBeNull()
    unsubscribe()
  })

  it('repolls immediately when a long watch returns the same full snapshot', async () => {
    const current = snapshot({ revision: 7 })
    const held = heldWatch()
    const get = vi.fn<AdmissionSnapshotRemote['get']>(async () => success(current))
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
      .mockResolvedValueOnce(success(current))
      .mockImplementation(held.call)
    const controller = new AdmissionSnapshotController({ get, watch })

    controller.start('root')
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2))

    expect(watch).toHaveBeenNthCalledWith(2, {
      sessionId: 'root',
      epoch: 'epoch-a',
      revision: 7,
      timeoutMs: WATCH_TIMEOUT_MS,
    }, expect.any(AbortSignal))
    controller.stop()
  })

  it('backs off at 250, 500, 1000, 2000, 5000 ms, caps, and resets after success', async () => {
    vi.useFakeTimers()
    const current = snapshot({ revision: 3 })
    const get = vi.fn<AdmissionSnapshotRemote['get']>()
    for (let index = 0; index < 6; index += 1) get.mockResolvedValueOnce(failure())
    get.mockResolvedValueOnce(success(current))
    const held = heldWatch()
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
      .mockRejectedValueOnce(new Error('transport reset'))
      .mockImplementation(held.call)
    const controller = new AdmissionSnapshotController({ get, watch })

    controller.start('root')
    await flushPromises()
    expect(get).toHaveBeenCalledTimes(1)

    const expectedDelays = [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!]
    for (const [index, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(get).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      await flushPromises()
      expect(get).toHaveBeenCalledTimes(index + 2)
    }

    expect(controller.getSnapshot()).toBe(current)
    expect(watch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]! - 1)
    expect(watch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(watch).toHaveBeenCalledTimes(2)

    controller.stop()
  })

  it('exposes a stable hook source and stops a late initial read from publishing', async () => {
    const initial = deferred<RemoteResult<AdmissionSnapshot>>()
    const get = vi.fn<AdmissionSnapshotRemote['get']>(async () => initial.promise)
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
    const controller = new AdmissionSnapshotController({ get, watch })

    const injection = controller.inject('root')
    expect(injection).toEqual({ hooks: { admission: controller } })
    expect(controller.inject('root').hooks.admission).toBe(controller)
    expect(get).toHaveBeenCalledTimes(1)

    controller.stop()
    initial.resolve(success(snapshot()))
    await flushPromises()
    expect(controller.getSnapshot()).toBeNull()
    expect(watch).not.toHaveBeenCalled()
  })
})

describe('admission Client entry', () => {
  it('mounts the generated Remote and tears the controller down before unmount', async () => {
    const events: string[] = []
    const stop = vi.spyOn(AdmissionSnapshotController.prototype, 'stop')
      .mockImplementation(() => { events.push('controller-stopped') })
    const disposeRemote = vi.fn(async () => { events.push('remote-unmounted') })
    const get = vi.fn<AdmissionSnapshotRemote['get']>(async () => success(snapshot()))
    const watch = vi.fn<AdmissionSnapshotRemote['watch']>()
    const mount = vi.fn(async () => disposeRemote)
    const ctx = {
      remote: {
        $mount: mount,
        snapshot: { get, watch },
      },
    } as unknown as ClientContext

    const dispose = await apply(ctx)
    expect(clientInject).toEqual(['remote', 'slots', 'locale', 'sessions'])
    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount.mock.calls[0]?.[0]).toMatchObject({
      package: 'dsh-subagent-admission',
      descriptors: [
        { id: 'dsh-subagent-admission#snapshot/get' },
        { id: 'dsh-subagent-admission#snapshot/watch' },
      ],
    })

    await dispose()
    expect(disposeRemote).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['controller-stopped', 'remote-unmounted'])
    stop.mockRestore()
  })
})
