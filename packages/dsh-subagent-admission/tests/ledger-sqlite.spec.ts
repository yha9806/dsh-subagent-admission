import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'

import { RootLedgerStore, type LedgerProbe } from '../src/host/ledger.js'
import { ledgerContract, type LedgerFixture } from './ledger.contract.js'

const ADMISSION_UNIT = 'subagent_admission'
const DB_FILE = 'ledger.sqlite'

function createProbe(): LedgerProbe {
  const probe = {
    writes: 0,
    didWrite: (): void => {
      probe.writes += 1
    },
  }
  return probe
}

interface Generation {
  ctx: Context
  ledger: RootLedgerStore
}

async function mountGeneration(
  dbPath: string,
  probe: LedgerProbe,
): Promise<Generation> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: dbPath, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  try {
    const ledger = await RootLedgerStore.open(ctx.storageDomain, probe)
    return { ctx, ledger }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function openSqliteFixture(): Promise<LedgerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admission-sqlite-'))
  const dbPath = join(root, DB_FILE)
  const probe = createProbe()

  let ctx: Context
  let ledger: RootLedgerStore
  let lock: DatabaseSync | null = null
  let closing: Promise<void> | null = null
  let disposed = false

  async function closeMedium(): Promise<void> {
    if (closing === null) closing = doClose()
    return closing
  }

  async function doClose(): Promise<void> {
    try {
      await ledger.close()
    } finally {
      await ctx.fiber.dispose()
    }
  }

  async function reopen(): Promise<void> {
    await closeMedium()
    const generation = await mountGeneration(dbPath, probe)
    ctx = generation.ctx
    ledger = generation.ledger
    closing = null
  }

  async function failWrites(): Promise<void> {
    if (lock !== null) return
    const blocker = new DatabaseSync(dbPath)
    try {
      blocker.exec('PRAGMA busy_timeout = 0')
      blocker.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      blocker.close()
      throw error
    }
    lock = blocker
  }

  async function repairWrites(): Promise<void> {
    if (lock === null) return
    const blocker = lock
    lock = null
    try {
      blocker.exec('ROLLBACK')
    } finally {
      blocker.close()
    }
  }

  async function corruptStoredSchema(): Promise<void> {
    await closeMedium()
    await repairWrites()
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`UPDATE units SET version = 999 WHERE name = '${ADMISSION_UNIT}'`)
    } finally {
      db.close()
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    try {
      await repairWrites()
      await closeMedium()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  const generation = await mountGeneration(dbPath, probe)
  ctx = generation.ctx
  ledger = generation.ledger

  const fixture: LedgerFixture = {
    get ledger(): RootLedgerStore {
      return ledger
    },
    probe,
    reopen,
    failWrites,
    repairWrites,
    corruptStoredSchema,
    closeMedium,
    dispose,
  }
  return fixture
}

ledgerContract(openSqliteFixture)
