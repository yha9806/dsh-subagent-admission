import { describe, expect, it } from 'vitest'

import type { AdmissionLimits } from '../src/types.js'
import type { LedgerProbe, ReserveNewInput, RootLedgerStore } from '../src/host/ledger.js'
import type { RootLedgerRow } from '../src/host/ledger-spec.js'

/**
 * Backend-independent capability surface that every ledger suite fixture must
 * provide. The contract below exercises `RootLedgerStore` behavior only and
 * must pass unchanged against both JSON and SQLite media.
 */
export interface LedgerFixture {
  /** Current store handle; `reopen()` reassigns this to the reopened store. */
  ledger: RootLedgerStore
  /** Shared write instrumentation; counts span close/reopen cycles. */
  probe: LedgerProbe
  /** Closes and reopens the same durable medium, then updates `ledger`. */
  reopen(): Promise<void>
  /** Installs a real medium-level write failure. */
  failWrites(): Promise<void>
  /** Removes the failure installed by `failWrites()`. */
  repairWrites(): Promise<void>
  /** After `closeMedium()`, corrupts the stored schema/records so reopen fails. */
  corruptStoredSchema(): Promise<void>
  /** Closes the medium; concurrent calls must settle without throwing. */
  closeMedium(): Promise<void>
  /** Releases the medium and remaining resources; call once per fixture. */
  dispose(): Promise<void>
}

export const LIMITS: AdmissionLimits = {
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
}

const NOOP = (): void => {}

async function reserve(
  ledger: RootLedgerStore,
  overrides: Partial<ReserveNewInput> = {},
  assertActive: () => void = NOOP,
): Promise<RootLedgerRow> {
  return ledger.reserveNew(
    {
      rootSessionId: 'root',
      parentSessionId: 'parent',
      limits: LIMITS,
      now: 1,
      ...overrides,
    },
    assertActive,
  )
}

export function ledgerContract(open: () => Promise<LedgerFixture>): void {
  describe('ledger contract', () => {
    it('enforces the parent cap and checks the root total first', async () => {
      const fx = await open()
      try {
        for (let now = 1; now <= 8; now += 1) {
          await reserve(fx.ledger, { rootSessionId: 'root-parent-cap', now })
        }
        await expect(
          reserve(fx.ledger, { rootSessionId: 'root-parent-cap', now: 9 }),
        ).rejects.toMatchObject({ code: 'PARENT_CHILD_LIMIT' })
        expect(fx.probe.writes).toBe(8)

        const capped = (await fx.ledger.read('root-parent-cap')) as RootLedgerRow
        expect(capped).toBeDefined()
        expect(capped.admittedTotal).toBe(8)
        expect(capped.admittedChildrenByParent['parent']).toBe(8)
        expect(capped.revision).toBe(8)
        expect(capped.coverageStartedAt).toBe(1)

        const tight: AdmissionLimits = {
          ...LIMITS,
          perRootAdmittedTotal: 1,
          perParentChildren: 1,
        }
        await reserve(fx.ledger, { rootSessionId: 'root-total-first', limits: tight, now: 1 })
        await expect(
          reserve(fx.ledger, { rootSessionId: 'root-total-first', limits: tight, now: 2 }),
        ).rejects.toMatchObject({ code: 'ROOT_TOTAL_LIMIT' })
        expect(fx.probe.writes).toBe(9)
      } finally {
        await fx.dispose()
      }
    })

    it('invokes the active callback once and preserves a thrown rejection', async () => {
      const fx = await open()
      try {
        let calls = 0
        const throwing = (): void => {
          calls += 1
          throw { code: 'ROOT_ACTIVE_LIMIT' }
        }

        await expect(reserve(fx.ledger, { now: 1 }, throwing)).rejects.toMatchObject({
          code: 'ROOT_ACTIVE_LIMIT',
        })
        expect(calls).toBe(1)
        expect(fx.probe.writes).toBe(0)
        await expect(fx.ledger.read('root')).resolves.toBeUndefined()

        for (let now = 2; now <= 9; now += 1) {
          await reserve(fx.ledger, { now }, NOOP)
        }
        await expect(reserve(fx.ledger, { now: 10 }, throwing)).rejects.toMatchObject({
          code: 'PARENT_CHILD_LIMIT',
        })
        expect(calls).toBe(1)
      } finally {
        await fx.dispose()
      }
    })

    it('admits exactly 24 of 25 concurrent attempts', async () => {
      const fx = await open()
      try {
        const concurrentLimits: AdmissionLimits = {
          ...LIMITS,
          // Parent cap above the attempt count so the root total is the binding limiter.
          perParentChildren: 32,
        }

        const attempts = await Promise.allSettled(
          Array.from({ length: 25 }, (_, index) =>
            reserve(fx.ledger, { limits: concurrentLimits, now: index + 1 }, NOOP),
          ),
        )
        const fulfilled = attempts.filter(
          (result): result is PromiseFulfilledResult<RootLedgerRow> =>
            result.status === 'fulfilled',
        )
        const rejected = attempts.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )

        expect(fulfilled).toHaveLength(24)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
          code: 'ROOT_TOTAL_LIMIT',
        })
        expect(fx.probe.writes).toBe(24)

        const row = (await fx.ledger.read('root')) as RootLedgerRow
        expect(row).toBeDefined()
        expect(row.admittedTotal).toBe(24)
        expect(row.admittedChildrenByParent['parent']).toBe(24)
        expect(row.revision).toBe(24)
      } finally {
        await fx.dispose()
      }
    })

    it('persists rows across reopen and keeps the first coverage timestamp', async () => {
      const fx = await open()
      try {
        await reserve(fx.ledger, { now: 5 })
        await fx.closeMedium()
        await fx.reopen()

        const afterReopen = (await fx.ledger.read('root')) as RootLedgerRow
        expect(afterReopen).toBeDefined()
        expect(afterReopen.admittedTotal).toBe(1)
        expect(afterReopen.coverageStartedAt).toBe(5)
        expect(afterReopen.revision).toBe(1)

        await reserve(fx.ledger, { now: 9 })
        const afterNext = (await fx.ledger.read('root')) as RootLedgerRow
        expect(afterNext.admittedTotal).toBe(2)
        expect(afterNext.coverageStartedAt).toBe(5)
        expect(afterNext.revision).toBe(2)
      } finally {
        await fx.dispose()
      }
    })

    it('maps medium write failures to ADMISSION_STATE_IO and recovers after repair', async () => {
      const fx = await open()
      try {
        await reserve(fx.ledger, { now: 1 })
        await fx.failWrites()

        await expect(reserve(fx.ledger, { now: 2 })).rejects.toMatchObject({
          code: 'ADMISSION_STATE_IO',
        })
        expect(fx.probe.writes).toBe(1)

        const unchanged = (await fx.ledger.read('root')) as RootLedgerRow
        expect(unchanged.admittedTotal).toBe(1)
        expect(unchanged.revision).toBe(1)

        await fx.repairWrites()
        await reserve(fx.ledger, { now: 2 })
        expect(fx.probe.writes).toBe(2)

        const recovered = (await fx.ledger.read('root')) as RootLedgerRow
        expect(recovered.admittedTotal).toBe(2)
        expect(recovered.revision).toBe(2)
      } finally {
        await fx.dispose()
      }
    })

    it('fails closed when the active callback returns a thenable', async () => {
      const fx = await open()
      try {
        const asyncShaped = (() => Promise.resolve()) as unknown as () => void

        await expect(reserve(fx.ledger, { now: 1 }, asyncShaped)).rejects.toMatchObject({
          code: 'ADMISSION_STATE_IO',
        })
        expect(fx.probe.writes).toBe(0)
        await expect(fx.ledger.read('root')).resolves.toBeUndefined()
      } finally {
        await fx.dispose()
      }
    })

    it('returns frozen and defensively isolated reads', async () => {
      const fx = await open()
      try {
        await reserve(fx.ledger, { now: 1 })

        const first = (await fx.ledger.read('root')) as RootLedgerRow
        expect(first).toBeDefined()
        expect(Object.isFrozen(first)).toBe(true)
        expect(Object.isFrozen(first.admittedChildrenByParent)).toBe(true)

        /** Test-only mutable view: the runtime row stays frozen, so writes throw. */
        type MutableRootLedgerRow = {
          -readonly [K in keyof RootLedgerRow]: RootLedgerRow[K]
        }

        const mutate = (): void => {
          const mutableFirst = first as MutableRootLedgerRow
          mutableFirst.admittedTotal = 999
          ;(mutableFirst.admittedChildrenByParent as Record<string, number>)['parent'] = 999
        }
        expect(mutate).toThrow(TypeError)

        const second = (await fx.ledger.read('root')) as RootLedgerRow
        expect(second.admittedTotal).toBe(1)
        expect(second.admittedChildrenByParent['parent']).toBe(1)
      } finally {
        await fx.dispose()
      }
    })

    it('drains an enqueued reservation through close and reopens it', async () => {
      const fx = await open()
      try {
        const pending = reserve(fx.ledger, { now: 1 })
        const closes = await Promise.allSettled([
          fx.closeMedium(),
          fx.closeMedium(),
          fx.closeMedium(),
        ])
        expect(closes.every((result) => result.status === 'fulfilled')).toBe(true)

        await expect(pending).resolves.toBeDefined()
        expect(fx.probe.writes).toBe(1)
        await expect(fx.ledger.read('root')).rejects.toMatchObject({
          code: 'ADMISSION_STATE_IO',
        })
        await expect(reserve(fx.ledger, { now: 2 })).rejects.toMatchObject({
          code: 'ADMISSION_STATE_IO',
        })

        await fx.reopen()
        const row = (await fx.ledger.read('root')) as RootLedgerRow
        expect(row).toBeDefined()
        expect(row.admittedTotal).toBe(1)
        expect(fx.probe.writes).toBe(1)
      } finally {
        await fx.dispose()
      }
    })

    it('fails reopen with sanitized ADMISSION_STATE_IO on corrupted storage', async () => {
      const fx = await open()
      try {
        await reserve(fx.ledger, { now: 1 })
        await fx.closeMedium()
        await fx.corruptStoredSchema()

        const reopenError = await fx.reopen().then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(reopenError).toBeInstanceOf(Error)
        expect(reopenError).toMatchObject({ code: 'ADMISSION_STATE_IO' })
        expect((reopenError as Error).message).toBe(
          'Ledger operational error: ADMISSION_STATE_IO',
        )
      } finally {
        await fx.dispose()
      }
    })

    it('rejects blank IDs, invalid now, and invalid limits before callback and write', async () => {
      const fx = await open()
      try {
        let callbackCalls = 0
        const spy = (): void => {
          callbackCalls += 1
        }

        const invalidInputs: ReserveNewInput[] = [
          { rootSessionId: '', parentSessionId: 'parent', limits: LIMITS, now: 1 },
          { rootSessionId: 'root', parentSessionId: '', limits: LIMITS, now: 1 },
          { rootSessionId: 'root', parentSessionId: 'parent', limits: LIMITS, now: -1 },
          { rootSessionId: 'root', parentSessionId: 'parent', limits: LIMITS, now: Number.NaN },
          { rootSessionId: 'root', parentSessionId: 'parent', limits: LIMITS, now: 1.5 },
          {
            rootSessionId: 'root',
            parentSessionId: 'parent',
            limits: LIMITS,
            now: Number.MAX_SAFE_INTEGER + 1,
          },
          {
            rootSessionId: 'root',
            parentSessionId: 'parent',
            limits: { ...LIMITS, globalActive: 0 },
            now: 1,
          },
          {
            rootSessionId: 'root',
            parentSessionId: 'parent',
            limits: { ...LIMITS, perRootActive: Number.NaN },
            now: 1,
          },
          {
            rootSessionId: 'root',
            parentSessionId: 'parent',
            limits: { ...LIMITS, perRootAdmittedTotal: -1 },
            now: 1,
          },
          {
            rootSessionId: 'root',
            parentSessionId: 'parent',
            limits: { ...LIMITS, perParentChildren: 0.5 },
            now: 1,
          },
        ]

        for (const input of invalidInputs) {
          await expect(fx.ledger.reserveNew(input, spy)).rejects.toMatchObject({
            code: 'ADMISSION_STATE_IO',
          })
        }

        expect(callbackCalls).toBe(0)
        expect(fx.probe.writes).toBe(0)
      } finally {
        await fx.dispose()
      }
    })
  })
}
