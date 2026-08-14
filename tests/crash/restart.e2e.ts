import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'

import { AdmissionAuthority } from '../../src/host/authority.js'
import { RootLedgerStore } from '../../src/host/ledger.js'
import { ActiveLeaseRegistry } from '../../src/host/leases.js'

type Backend = 'json' | 'sqlite'

const backend = process.env.DSH_CRASH_BACKEND as Backend | undefined
const root = process.env.DSH_CRASH_ROOT
const evidenceDir = process.env.DSH_ADMISSION_EVIDENCE_DIR
const composed = process.env.DSH_CRASH_COMPOSED === '1'
let evidence: Record<string, unknown> = {
  schemaVersion: 1,
  status: 'fail',
  reason: 'restart fixture did not execute',
}

async function mountStorage(selected: Backend, storageRoot: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  if (selected === 'json') {
    await ctx.plugin(StorageJson, { root: join(storageRoot, 'json') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  } else {
    await ctx.plugin(StorageSqlite, {
      path: join(storageRoot, 'ledger.sqlite'),
      journalMode: 'delete',
    })
    await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  }
  return ctx
}

describe('post-ledger-commit restart', () => {
  it('preserves cumulative truth, drops process-local leases, and denies the next child', async () => {
    expect(composed, 'restart must run through crash-fixture.mts').toBe(true)
    expect(backend === 'json' || backend === 'sqlite').toBe(true)
    expect(root).toBeTruthy()
    const selected = backend as Backend
    const storageRoot = root as string
    const ctx = await mountStorage(selected, storageRoot)
    const ledger = await RootLedgerStore.open(ctx.storageDomain)
    try {
      const reopened = await ledger.read('root')
      expect(reopened).toMatchObject({
        rootSessionId: 'root',
        admittedTotal: 1,
        revision: 1,
      })

      const leases = new ActiveLeaseRegistry()
      expect(leases.globalActive).toBe(0)
      expect(leases.snapshot()).toEqual([])
      const authority = new AdmissionAuthority({
        limits: {
          globalActive: 1,
          perRootActive: 1,
          perRootAdmittedTotal: 1,
          perParentChildren: 1,
        },
        policyEpoch: `restart-${selected}`,
        roots: {
          resolve: async () => Object.freeze({
            rootSessionId: 'root',
            lineage: Object.freeze(['root']),
          }),
          bindChild: (): void => {},
        },
        ledger,
        guard: { assertHeld: async (): Promise<void> => {} },
        leases,
        clock: { now: (): number => 2 },
      })

      await expect(authority.prepare({
        requestId: `restart-request-${selected}`,
        operation: 'new-one-shot',
        provider: 'crash-fixture',
        parentSessionId: 'root',
      })).rejects.toMatchObject({
        code: 'ROOT_TOTAL_LIMIT',
        observedValue: 1,
        limit: 1,
      })
      expect(leases.globalActive).toBe(0)
      expect(leases.snapshot()).toEqual([])

      evidence = {
        schemaVersion: 1,
        status: 'pass',
        backend: selected,
        rootAdmittedTotal: reopened?.admittedTotal,
        rootRevision: reopened?.revision,
        globalActive: leases.globalActive,
        activeLeases: leases.snapshot(),
        nextAdmissionCode: 'ROOT_TOTAL_LIMIT',
      }
    } finally {
      await ledger.close()
      await ctx.fiber.dispose()
    }
  })
})

afterAll(() => {
  if (evidenceDir === undefined || backend === undefined) return
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `crash-${backend}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
})
