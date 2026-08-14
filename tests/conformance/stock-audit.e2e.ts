import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import * as AdmissionPlugin from 'dsh-subagent-admission'

const evidenceDir = process.env.DSH_ADMISSION_EVIDENCE_DIR
const composed = process.env.DSH_STOCK_AUDIT_COMPOSED === '1'
let evidence: Record<string, unknown> = {
  schemaVersion: 1,
  status: 'fail',
  reason: 'stock Audit fixture did not execute',
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

class HeldStockProvider implements SubagentProvider {
  readonly name = 'stock-held'
  readonly capabilities = NO_CAPABILITIES
  readonly inheritsParentContext = false
  private readonly settlements: Array<Deferred<SubagentResult>> = []
  starts = 0

  start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.starts += 1
    const settlement = deferred<SubagentResult>()
    this.settlements.push(settlement)
    return Promise.resolve({
      id: SessionId(`stock-child-${this.starts}`),
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

function fakeParent(): ResolvedSubagentStartRequest['parent'] {
  return { id: SessionId('stock-root') } as ResolvedSubagentStartRequest['parent']
}

describe('unpatched npm rc.6 Audit conformance', () => {
  it('observes seven concurrent children without registering or enforcing a policy', async () => {
    expect(composed, 'stock Audit must run through the composed rc.6 runner').toBe(true)
    const manifest = await import('@deepseek-ai/dsh-subagent/package.json', {
      with: { type: 'json' },
    }) as { default: { version: string } }
    expect(manifest.default.version).toBe('0.1.0-rc.6')

    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    expect((ctx.subagents as unknown as Record<string, unknown>).admissionProtocolVersion)
      .toBeUndefined()
    expect((ctx.subagents as unknown as Record<string, unknown>).registerAdmissionPolicy)
      .toBeUndefined()

    const provider = new HeldStockProvider()
    ctx.subagents.registerProvider(provider)
    const disposeAdmission = await AdmissionPlugin.apply(ctx, {
      mode: 'audit',
      globalActive: 6,
      perRootActive: 4,
      perRootAdmittedTotal: 24,
      perParentChildren: 8,
    })
    try {
      const runs = await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          ctx.subagents.start(provider.name, {
            label: `stock concurrent ${index + 1}`,
            prompt: [{ type: 'text', text: 'hold' }],
            parent: fakeParent(),
            signal: new AbortController().signal,
          }),
        ),
      )
      expect(runs).toHaveLength(7)
      expect(provider.starts).toBe(7)

      const active = ctx.subagentAdmission.currentSnapshot('stock-root')
      expect(active).toMatchObject({
        mode: 'audit',
        enforced: false,
        reason: 'audit-observation-only',
        usage: {
          globalActive: 0,
          rootActive: 0,
          rootAdmittedTotal: 0,
          parentChildren: 0,
        },
        leases: [],
      })
      expect(active.history.filter((event) => event.kind === 'accepted')).toHaveLength(7)

      provider.finishAll()
      await Promise.all(runs.map((run) => run.result))
      await vi.waitFor(() => {
        const settled = ctx.subagentAdmission.currentSnapshot('stock-root')
        expect(settled.history.filter((event) => event.kind === 'released')).toHaveLength(7)
      })
      await Promise.all(runs.map((run) => run.dispose()))

      const settled = ctx.subagentAdmission.currentSnapshot('stock-root')
      evidence = {
        schemaVersion: 1,
        status: 'pass',
        runtimePackageVersion: manifest.default.version,
        mode: settled.mode,
        enforced: settled.enforced,
        policySurfacePresent: false,
        concurrentChildrenAccepted: runs.length,
        acceptedEvents: settled.history.filter((event) => event.kind === 'accepted').length,
        releasedEvents: settled.history.filter((event) => event.kind === 'released').length,
        usage: settled.usage,
        leases: settled.leases,
      }
    } finally {
      await disposeAdmission()
      await ctx.fiber.dispose()
    }
  })
})

afterAll(() => {
  if (evidenceDir === undefined) return
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, 'stock-audit.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
})
