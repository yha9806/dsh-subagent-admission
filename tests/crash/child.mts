#!/usr/bin/env tsx
/** Child fixture materialized under the package, then killed after durable commit. */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { join } from 'node:path'

import { AdmissionAuthority } from '../../src/host/authority.js'
import { RootLedgerStore } from '../../src/host/ledger.js'
import { ActiveLeaseRegistry } from '../../src/host/leases.js'

type Backend = 'json' | 'sqlite'

interface Arguments {
  readonly backend: Backend
  readonly root: string
}

function fail(message: string): never {
  throw new Error(`crash child: ${message}`)
}

function parseArguments(argv: readonly string[]): Arguments {
  let backend: Backend | undefined
  let root: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--backend' && (value === 'json' || value === 'sqlite')) {
      backend = value
      continue
    }
    if (flag === '--root' && typeof value === 'string' && value.length > 0) {
      root = value
      continue
    }
    fail(`unexpected argument ${String(flag)}`)
  }
  if (backend === undefined || root === undefined) {
    fail('usage: child.mts --backend json|sqlite --root ABSOLUTE_PATH')
  }
  return Object.freeze({ backend, root })
}

async function mountStorage(backend: Backend, root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  if (backend === 'json') {
    await ctx.plugin(StorageJson, { root: join(root, 'json') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  } else {
    await ctx.plugin(StorageSqlite, {
      path: join(root, 'ledger.sqlite'),
      journalMode: 'delete',
    })
    await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  }
  return ctx
}

async function marker(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('LEDGER_COMMITTED\n', (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}

const args = parseArguments(process.argv.slice(2))
if (process.env.DSH_CRASH_CHILD_COMPOSED !== '1') {
  fail('child must be materialized and launched by crash-fixture.mts')
}

const ctx = await mountStorage(args.backend, args.root)
const ledger = await RootLedgerStore.open(ctx.storageDomain)
const leases = new ActiveLeaseRegistry()
const authority = new AdmissionAuthority({
  limits: {
    globalActive: 1,
    perRootActive: 1,
    perRootAdmittedTotal: 1,
    perParentChildren: 1,
  },
  policyEpoch: `crash-${args.backend}`,
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
  clock: { now: (): number => 1 },
})

await authority.prepare({
  requestId: `crash-request-${args.backend}`,
  operation: 'new-one-shot',
  provider: 'crash-fixture',
  parentSessionId: 'root',
})

if (leases.globalActive !== 1 || leases.snapshot().length !== 1) {
  fail('admission did not own one active lease after ledger commit')
}
await marker()

// Keep the exact process alive between durable commit and simulated crash.
await new Promise<never>(() => {
  setInterval(() => {}, 1_000)
})
