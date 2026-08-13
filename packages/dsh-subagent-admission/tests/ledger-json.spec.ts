import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

import type { LedgerProbe } from '../src/host/ledger.js'
import { RootLedgerStore } from '../src/host/ledger.js'
import {
  ROOT_LEDGER_DOMAIN_NAME,
  ROOT_LEDGER_DOMAIN_VERSION,
} from '../src/host/ledger-spec.js'
import { ledgerContract } from './ledger.contract.js'

interface JsonLedgerFixture {
  ledger: RootLedgerStore
  probe: LedgerProbe
  reopen(): Promise<void>
  failWrites(): Promise<void>
  repairWrites(): Promise<void>
  corruptStoredSchema(): Promise<void>
  closeMedium(): Promise<void>
  dispose(): Promise<void>
}

function createProbe(): LedgerProbe {
  const probe = {
    writes: 0,
    didWrite: (): void => {
      probe.writes += 1
    },
  }
  return probe
}

async function mountJsonContext(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

async function openJsonFixture(): Promise<JsonLedgerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admission-json-'))
  const filePath = join(root, `${ROOT_LEDGER_DOMAIN_NAME}.json`)
  const backupPath = join(root, `${ROOT_LEDGER_DOMAIN_NAME}.json.bak`)
  const probe = createProbe()

  let ctx = await mountJsonContext(root)
  let ledger = await RootLedgerStore.open(ctx.storageDomain, probe)
  let closed = false
  let closing: Promise<void> | undefined

  async function closeMedium(): Promise<void> {
    if (!closed) {
      closed = true
      closing = (async () => {
        try {
          await ledger.close()
        } finally {
          await ctx.fiber.dispose()
        }
      })()
    }
    await closing
  }

  async function reopen(): Promise<void> {
    await closeMedium()
    const nextCtx = await mountJsonContext(root)
    try {
      const nextLedger = await RootLedgerStore.open(nextCtx.storageDomain, probe)
      ledger = nextLedger
      ctx = nextCtx
    } catch (error) {
      closed = true
      try {
        await nextCtx.fiber.dispose()
      } catch {
        // best-effort: dispose must stay safe after a failed open
      }
      throw error
    }
    closed = false
    closing = undefined
  }

  async function failWrites(): Promise<void> {
    const current = await stat(filePath).catch(() => undefined)
    if (current?.isFile()) {
      await rename(filePath, backupPath)
      await mkdir(filePath)
    }
  }

  async function repairWrites(): Promise<void> {
    const current = await stat(filePath).catch(() => undefined)
    if (current?.isDirectory()) {
      await rm(filePath, { recursive: true })
    }
    const restored = await stat(filePath).catch(() => undefined)
    const backup = await stat(backupPath).catch(() => undefined)
    if (backup?.isFile() && restored === undefined) {
      await rename(backupPath, filePath)
    }
  }

  async function corruptStoredSchema(): Promise<void> {
    const text = await readFile(filePath, 'utf8')
    const document = JSON.parse(text) as {
      unit: { name: string; version: number }
    }
    document.unit.version = ROOT_LEDGER_DOMAIN_VERSION + 1
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`)
  }

  async function dispose(): Promise<void> {
    try {
      await closeMedium()
    } catch {
      // best-effort: never leave the temporary root behind
    }
    await rm(root, { recursive: true, force: true })
  }

  const fixture: JsonLedgerFixture = {
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

ledgerContract(openJsonFixture)
