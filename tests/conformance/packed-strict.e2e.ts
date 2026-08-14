import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import * as AdmissionPlugin from 'dsh-subagent-admission'

const evidenceDir = process.env.DSH_ADMISSION_EVIDENCE_DIR
const patchedCheckout = process.env.DSH_ADMISSION_PATCHED_CHECKOUT === '1'
const sourceCommit = process.env.DSH_ADMISSION_SOURCE_COMMIT ?? ''
const root = mkdtempSync(join(tmpdir(), 'dsh-packed-strict-fixture-'))
let evidence: Record<string, unknown> = {
  schemaVersion: 1,
  status: 'fail',
  reason: 'packed Strict fixture did not execute',
}

const NO_CAPABILITIES = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class HeldProvider implements SubagentProvider {
  readonly name = 'packed-held'
  readonly capabilities = NO_CAPABILITIES
  readonly inheritsParentContext = false
  private readonly settlements: Deferred<SubagentResult>[] = []
  starts = 0

  start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.starts += 1
    const settlement = deferred<SubagentResult>()
    this.settlements.push(settlement)
    return Promise.resolve({
      id: SessionId(`packed-child-${this.starts}`),
      localAgent: undefined,
      result: settlement.promise,
      dispose: async (): Promise<void> => {},
    })
  }

  finishAll(): void {
    for (const settlement of this.settlements) {
      settlement.resolve({
        output: [{ type: 'text', text: 'complete' }],
        stopReason: 'completed',
      })
    }
  }
}

function request(parent: Agent, index: number) {
  return {
    label: `packed strict child ${index}`,
    prompt: [{ type: 'text' as const, text: 'hold' }],
    parent,
    signal: new AbortController().signal,
  }
}

describe('packed Strict exact-target proof', () => {
  it('admits three children under each root and denies the seventh globally before provider work', async () => {
    expect(patchedCheckout, 'fixture must run only in the patched exact checkout').toBe(true)
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    const manifest = await import('@deepseek-ai/dsh-subagent/package.json', {
      with: { type: 'json' },
    }) as { default: { version: string } }
    expect(manifest.default.version).toBe('0.1.0-rc.5')

    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)

    const rootA = ctx.agentLoop.create(SessionId('packed-root-a'))
    const rootB = ctx.agentLoop.create(SessionId('packed-root-b'))
    const provider = new HeldProvider()
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(AdmissionPlugin, {
      mode: 'strict',
      globalActive: 6,
      perRootActive: 4,
      perRootAdmittedTotal: 24,
      perParentChildren: 8,
      ownershipPath: join(root, 'admission-owner'),
    })

    const runs: SubagentRun[] = []
    try {
      for (let index = 0; index < 3; index += 1) {
        runs.push(await ctx.subagents.start(provider.name, request(rootA, index + 1)))
        runs.push(await ctx.subagents.start(provider.name, request(rootB, index + 4)))
      }
      expect(provider.starts).toBe(6)

      let denied: unknown
      try {
        await ctx.subagents.start(provider.name, request(rootA, 7))
      } catch (error: unknown) {
        denied = error
      }
      expect(denied).toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
      expect(provider.starts).toBe(6)

      const snapshotA = ctx.subagentAdmission.currentSnapshot(rootA.id)
      const snapshotB = ctx.subagentAdmission.currentSnapshot(rootB.id)
      expect(snapshotA).toMatchObject({
        mode: 'strict',
        enforced: true,
        usage: { globalActive: 6, rootActive: 3 },
      })
      expect(snapshotB).toMatchObject({
        mode: 'strict',
        enforced: true,
        usage: { globalActive: 6, rootActive: 3 },
      })

      evidence = {
        schemaVersion: 1,
        status: 'pass',
        sourceCommit,
        sourcePackageVersion: manifest.default.version,
        mode: snapshotA.mode,
        enforced: snapshotA.enforced,
        acceptedActivations: runs.length,
        attemptedActivations: runs.length + 1,
        providerStarts: provider.starts,
        deniedCode: (denied as { code: string }).code,
        activeByRootBeforeDenial: {
          [rootA.id]: snapshotA.usage.rootActive,
          [rootB.id]: snapshotB.usage.rootActive,
        },
      }
    } finally {
      provider.finishAll()
      await Promise.all(runs.map(run => run.result))
      await Promise.all(runs.map(run => run.dispose()))
      await ctx.fiber.dispose()
    }
  }, 30_000)
})

afterAll(() => {
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(
      join(evidenceDir, 'packed-strict.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    )
  }
  rmSync(root, { recursive: true, force: true })
})
