import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as AdmissionPlugin from 'dsh-subagent-admission'
import type { AdmissionSnapshot } from 'dsh-subagent-admission'

import { BarrierProvider, ControlledTurnAdapter } from './fake-provider.ts'
import {
  createLifecycleBarriers,
  openAllBarriers,
  type LifecycleBarriers,
} from './lifecycle-barriers.ts'
import {
  CONFORMANCE_CASES,
  CONFORMANCE_ENTRY_POINTS,
  REQUIRED_RESULT_IDS,
  matrixCaseId,
  scenarioCaseId,
  type ConformanceCase,
  type ConformanceEntryPoint,
  type ConformanceResult,
  type RequiredScenario,
} from './matrix.ts'

const evidenceDir = process.env.DSH_ADMISSION_EVIDENCE_DIR
const patchedCheckout = process.env.DSH_ADMISSION_PATCHED_CHECKOUT === '1'
const results = new Map<string, ConformanceResult>()
const roots = new Set<string>()
let sequence = 0

interface StrictHarness {
  readonly ctx: Context
  readonly parent: Agent
  readonly barriers: LifecycleBarriers
  readonly provider: BarrierProvider
  readonly adapter: ControlledTurnAdapter
  readonly root: string
  readonly service: {
    currentSnapshot(sessionId: string): AdmissionSnapshot
    dispose(): Promise<void>
  }
}

interface HarnessOptions {
  readonly provider?: string
  readonly barriers?: LifecycleBarriers
  readonly providerOptions?: ConstructorParameters<typeof BarrierProvider>[2]
  readonly deferAdmission?: boolean
  readonly limits?: Partial<{
    globalActive: number
    perRootActive: number
    perRootAdmittedTotal: number
    perParentChildren: number
  }>
}

function record(
  id: string,
  status: ConformanceResult['status'],
  detail: Omit<ConformanceResult, 'id' | 'status' | 'reason'>,
  reason: string | null = null,
): void {
  results.set(id, Object.freeze({ id, status, reason, ...detail }))
}

function matrixTest(
  candidate: ConformanceCase,
  entryPoint: ConformanceEntryPoint,
  body: () => Promise<void>,
): void {
  const id = matrixCaseId(candidate, entryPoint)
  it(id, async () => {
    try {
      await body()
      record(id, 'pass', {
        provider: candidate.provider,
        shape: candidate.shape,
        scheduling: candidate.scheduling,
        entryPoint,
        scenario: null,
      })
    } catch (error: unknown) {
      record(id, 'fail', {
        provider: candidate.provider,
        shape: candidate.shape,
        scheduling: candidate.scheduling,
        entryPoint,
        scenario: null,
      }, errorMessage(error))
      throw error
    }
  })
}

function scenarioTest(
  scenario: RequiredScenario,
  body: () => Promise<void>,
): void {
  const id = scenarioCaseId(scenario)
  it(id, async () => {
    try {
      await body()
      record(id, 'pass', {
        provider: null,
        shape: null,
        scheduling: null,
        entryPoint: null,
        scenario,
      })
    } catch (error: unknown) {
      record(id, 'fail', {
        provider: null,
        shape: null,
        scheduling: null,
        entryPoint: null,
        scenario,
      }, errorMessage(error))
      throw error
    }
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error).slice(0, 500)
}

async function createHarness(options: HarnessOptions = {}): Promise<StrictHarness> {
  expect(patchedCheckout, 'strict conformance must run only in the patched exact checkout').toBe(true)
  const root = mkdtempSync(join(tmpdir(), `dsh-strict-conformance-${++sequence}-`))
  roots.add(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)

  const adapter = new ControlledTurnAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(
    SessionId(`root-${sequence}`),
    { provider: 'mock', model: 'mock' },
  )
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent !== parent) return next()
    return { kind: 'reject' as const }
  })
  const barriers = options.barriers ?? createLifecycleBarriers()
  const provider = new BarrierProvider(
    options.provider ?? 'spawn',
    barriers,
    options.providerOptions,
  )
  ctx.subagents.registerProvider(provider)

  if (!(options.deferAdmission ?? false)) {
    await mountAdmission(ctx, root, options.limits)
  }
  return {
    ctx,
    parent,
    barriers,
    provider,
    adapter,
    root,
    get service() {
      return ctx.subagentAdmission
    },
  }
}

async function mountAdmission(
  ctx: Context,
  root: string,
  limits: HarnessOptions['limits'] = {},
): Promise<void> {
  await ctx.plugin(AdmissionPlugin, {
    mode: 'strict',
    ownershipPath: join(root, 'admission-owner'),
    ...limits,
  })
}

async function cleanupHarness(
  harness: StrictHarness,
  options: { readonly skipContext?: boolean } = {},
): Promise<void> {
  openAllBarriers(harness.barriers)
  if (!(options.skipContext ?? false)) {
    await harness.ctx.fiber.dispose()
  }
  rmSync(harness.root, { recursive: true, force: true })
  roots.delete(harness.root)
}

function snapshot(harness: StrictHarness, sessionId = harness.parent.id): AdmissionSnapshot {
  return harness.service.currentSnapshot(sessionId)
}

function expectStrictUsage(
  harness: StrictHarness,
  active: number,
  admittedTotal: number,
): void {
  expect(snapshot(harness)).toMatchObject({
    mode: 'strict',
    enforced: true,
    reason: null,
    usage: {
      globalActive: active,
      rootActive: active,
      rootAdmittedTotal: admittedTotal,
    },
  })
}

async function waitForActive(
  harness: StrictHarness,
  active: number,
  admittedTotal: number,
): Promise<void> {
  await vi.waitFor(() => expectStrictUsage(harness, active, admittedTotal), {
    timeout: 5_000,
  })
}

function startRequest(parent: Agent, signal = new AbortController().signal) {
  return {
    label: 'conformance child',
    prompt: [{ type: 'text' as const, text: 'work' }],
    parent,
    signal,
  }
}

async function runDirectOneShot(candidate: ConformanceCase): Promise<void> {
  const harness = await createHarness({ provider: candidate.provider })
  try {
    const starting = harness.ctx.subagents.start(
      candidate.provider,
      startRequest(harness.parent),
    )
    await harness.barriers.beforeProvider.reached
    expectStrictUsage(harness, 1, 1)
    expect(snapshot(harness).leases[0]?.childSessionId).toBeNull()

    harness.barriers.beforeProvider.open()
    const run = await starting
    await harness.barriers.resultSettled.reached
    expect(snapshot(harness).leases[0]?.childSessionId).toBe(run.id)
    expectStrictUsage(harness, 1, 1)

    harness.barriers.resultSettled.open()
    await run.result
    expectStrictUsage(harness, 1, 1)

    const disposing = run.dispose()
    await harness.barriers.beforeDisposeComplete.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.beforeDisposeComplete.open()
    await disposing
    await harness.barriers.finishDisposalComplete.reached
    expectStrictUsage(harness, 0, 1)
  } finally {
    await cleanupHarness(harness)
  }
}

async function mountTool(
  harness: StrictHarness,
  candidate: ConformanceCase,
): Promise<string> {
  await harness.ctx.plugin(LocalJobRegistry)
  await harness.ctx.plugin(ToolTasks, {})
  const toolName = `subagent_${candidate.provider}_${sequence}`
  await harness.ctx.plugin(ToolSubagent, {
    provider: candidate.provider,
    toolName,
    backgroundMode: candidate.shape === 'continuable' ? 'continuable' : 'one-shot',
    maxDepth: 'provider-managed',
  })
  return toolName
}

async function runToolOneShot(candidate: ConformanceCase): Promise<void> {
  const harness = await createHarness({ provider: candidate.provider })
  try {
    const toolName = await mountTool(harness, candidate)
    const executing = harness.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`matrix-${sequence}`),
      name: toolName,
      arguments: {
        description: 'conformance',
        prompt: 'work',
        run_in_background: candidate.scheduling === 'background',
      },
      agent: harness.parent,
    })
    await harness.barriers.beforeProvider.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.beforeProvider.open()
    await harness.barriers.resultSettled.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.resultSettled.open()
    await harness.barriers.beforeDisposeComplete.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.beforeDisposeComplete.open()
    await executing
    await waitForActive(harness, 0, 1)
  } finally {
    await cleanupHarness(harness)
  }
}

async function runDirectContinuable(candidate: ConformanceCase): Promise<void> {
  const harness = await createHarness({ provider: candidate.provider })
  const turn = harness.adapter.enqueue()
  try {
    const starting = harness.ctx.subagents.startContinuable({
      provider: candidate.provider,
      label: 'continuable conformance',
      request: {
        prompt: [{ type: 'text', text: 'work' }],
        parent: harness.parent,
      },
      signal: new AbortController().signal,
    })
    await harness.barriers.beforeMaterialize.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.beforeMaterialize.open()
    const started = await starting
    await turn.started
    expect(snapshot(harness).leases[0]?.childSessionId).toBe(started.childId)
    expectStrictUsage(harness, 1, 1)
    turn.release()
    await waitForActive(harness, 0, 1)
    harness.barriers.finishDisposalComplete.mark()
  } finally {
    await cleanupHarness(harness)
  }
}

async function runToolContinuable(candidate: ConformanceCase): Promise<void> {
  const harness = await createHarness({ provider: candidate.provider })
  const turn = harness.adapter.enqueue()
  try {
    const toolName = await mountTool(harness, candidate)
    const executing = harness.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`matrix-continuable-${sequence}`),
      name: toolName,
      arguments: {
        description: 'conformance',
        prompt: 'work',
        run_in_background: true,
      },
      agent: harness.parent,
    })
    await harness.barriers.beforeMaterialize.reached
    expectStrictUsage(harness, 1, 1)
    harness.barriers.beforeMaterialize.open()
    await executing
    await turn.started
    expectStrictUsage(harness, 1, 1)
    turn.release()
    await waitForActive(harness, 0, 1)
  } finally {
    await cleanupHarness(harness)
  }
}

describe('pinned strict conformance matrix', () => {
  for (const candidate of CONFORMANCE_CASES) {
    for (const entryPoint of CONFORMANCE_ENTRY_POINTS) {
      matrixTest(candidate, entryPoint, async () => {
        if (candidate.shape === 'one-shot') {
          if (entryPoint === 'direct-service') return runDirectOneShot(candidate)
          return runToolOneShot(candidate)
        }
        if (entryPoint === 'direct-service') return runDirectContinuable(candidate)
        return runToolContinuable(candidate)
      })
    }
  }
})

describe('strict lifecycle and failure scenarios', () => {
  scenarioTest('resident-followup', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    const first = harness.adapter.enqueue()
    const second = harness.adapter.enqueue()
    try {
      const starting = harness.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'resident',
        request: { prompt: [{ type: 'text', text: 'first' }], parent: harness.parent },
        signal: new AbortController().signal,
      })
      await harness.barriers.beforeMaterialize.reached
      harness.barriers.beforeMaterialize.open()
      const started = await starting
      await first.started
      await harness.ctx.subagents.followup(
        harness.parent,
        started.childId,
        [{ type: 'text', text: 'second' }],
        { source: { kind: 'user' }, signal: new AbortController().signal },
      )
      expectStrictUsage(harness, 1, 1)
      first.release()
      await second.started
      expectStrictUsage(harness, 1, 1)
      second.release()
      await waitForActive(harness, 0, 1)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('cold-resume', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    const first = harness.adapter.enqueue()
    const resumed = harness.adapter.enqueue()
    try {
      const starting = harness.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'cold',
        request: { prompt: [{ type: 'text', text: 'first' }], parent: harness.parent },
        signal: new AbortController().signal,
      })
      await harness.barriers.beforeMaterialize.reached
      harness.barriers.beforeMaterialize.open()
      const started = await starting
      await first.started
      first.release()
      await waitForActive(harness, 0, 1)

      await harness.ctx.subagents.followup(
        harness.parent,
        started.childId,
        [{ type: 'text', text: 'resume' }],
        { source: { kind: 'user' }, signal: new AbortController().signal },
      )
      await resumed.started
      expectStrictUsage(harness, 1, 1)
      expect(snapshot(harness).leases[0]?.operation).toBe('cold-resume')
      resumed.release()
      await waitForActive(harness, 0, 1)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('cancel-before-provider', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    try {
      const controller = new AbortController()
      controller.abort('cancelled before dispatch')
      await expect(
        harness.ctx.subagents.start('spawn', startRequest(harness.parent, controller.signal)),
      ).rejects.toBeDefined()
      expectStrictUsage(harness, 0, 0)
      expect(harness.barriers.beforeProvider.reachedNow).toBe(false)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('cancel-after-admission', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    try {
      const controller = new AbortController()
      const starting = harness.ctx.subagents.start(
        'spawn',
        startRequest(harness.parent, controller.signal),
      )
      await harness.barriers.beforeProvider.reached
      expectStrictUsage(harness, 1, 1)
      controller.abort('cancelled after admission')
      harness.barriers.beforeProvider.open()
      await expect(starting).rejects.toBeDefined()
      await waitForActive(harness, 0, 1)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('provider-failure', async () => {
    const harness = await createHarness({
      provider: 'spawn',
      providerOptions: { failStart: new Error('provider failed after cleanup') },
    })
    try {
      const starting = harness.ctx.subagents.start('spawn', startRequest(harness.parent))
      await harness.barriers.beforeProvider.reached
      expectStrictUsage(harness, 1, 1)
      harness.barriers.beforeProvider.open()
      await expect(starting).rejects.toThrow('provider failed after cleanup')
      await waitForActive(harness, 0, 1)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('prepare-failure', async () => {
    const harness = await createHarness({
      provider: 'spawn',
      providerOptions: { failPrepare: new Error('prepare failed after cleanup') },
    })
    try {
      const starting = harness.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'failed prepare',
        request: { prompt: [{ type: 'text', text: 'work' }], parent: harness.parent },
        signal: new AbortController().signal,
      })
      await harness.barriers.beforeMaterialize.reached
      expectStrictUsage(harness, 1, 1)
      harness.barriers.beforeMaterialize.open()
      await expect(starting).rejects.toThrow('prepare failed after cleanup')
      await waitForActive(harness, 0, 1)
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('materialize-failure', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    const resume = vi.spyOn(harness.ctx.agents, 'create')
      .mockRejectedValue(new Error('materialization rolled back'))
    try {
      const starting = harness.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'failed materialize',
        request: { prompt: [{ type: 'text', text: 'work' }], parent: harness.parent },
        signal: new AbortController().signal,
      })
      await harness.barriers.beforeMaterialize.reached
      harness.barriers.beforeMaterialize.open()
      await expect(starting).rejects.toThrow('materialization rolled back')
      await waitForActive(harness, 0, 1)
    } finally {
      resume.mockRestore()
      await cleanupHarness(harness)
    }
  })

  scenarioTest('cleanup-delay', async () => {
    await runDirectOneShot({
      provider: 'spawn',
      shape: 'one-shot',
      scheduling: 'foreground',
    })
  })

  scenarioTest('cleanup-failure-retains-lease', async () => {
    const harness = await createHarness({
      provider: 'spawn',
      providerOptions: { failDispose: new Error('cleanup not quiescent') },
    })
    try {
      const starting = harness.ctx.subagents.start('spawn', startRequest(harness.parent))
      await harness.barriers.beforeProvider.reached
      harness.barriers.beforeProvider.open()
      const run = await starting
      await harness.barriers.resultSettled.reached
      harness.barriers.resultSettled.open()
      await run.result
      const disposing = run.dispose()
      await harness.barriers.beforeDisposeComplete.reached
      harness.barriers.beforeDisposeComplete.open()
      await expect(disposing).rejects.toThrow('cleanup not quiescent')
      expectStrictUsage(harness, 1, 1)
    } finally {
      await cleanupHarness(harness, { skipContext: true })
    }
  })

  scenarioTest('policy-unload', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    try {
      const starting = harness.ctx.subagents.start('spawn', startRequest(harness.parent))
      await harness.barriers.beforeProvider.reached
      const disposingService = harness.service.dispose()
      await expect(
        harness.ctx.subagents.start('spawn', startRequest(harness.parent)),
      ).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
      harness.barriers.beforeProvider.open()
      const run = await starting
      await harness.barriers.resultSettled.reached
      harness.barriers.resultSettled.open()
      await run.result
      const disposingRun = run.dispose()
      await harness.barriers.beforeDisposeComplete.reached
      harness.barriers.beforeDisposeComplete.open()
      await disposingRun
      await disposingService
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('protocol-mismatch', async () => {
    const harness = await createHarness({ provider: 'spawn', deferAdmission: true })
    try {
      Object.defineProperty(harness.ctx.subagents, 'admissionProtocolVersion', {
        configurable: true,
        value: 2,
      })
      await mountAdmission(harness.ctx, harness.root)
      expect(snapshot(harness)).toMatchObject({
        mode: 'unavailable',
        enforced: false,
        reason: 'unsupported-admission-protocol',
      })
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('duplicate-registration', async () => {
    const harness = await createHarness({ provider: 'spawn', deferAdmission: true })
    const unregister = harness.ctx.subagents.registerAdmissionPolicy({
      protocolVersion: 1,
      prepare: async (): Promise<never> => {
        throw new Error('dummy policy must not run')
      },
    })
    try {
      await mountAdmission(harness.ctx, harness.root)
      expect(snapshot(harness)).toMatchObject({
        mode: 'unavailable',
        enforced: false,
        reason: 'policy-registration-failed',
      })
    } finally {
      unregister()
      await cleanupHarness(harness)
    }
  })

  scenarioTest('unsafe-bootstrap', async () => {
    const harness = await createHarness({ provider: 'spawn', deferAdmission: true })
    try {
      harness.ctx.sessions.create(SessionId(`dirty-child-${sequence}`), {
        meta: {
          parentSession: harness.parent.id,
          origin: 'subagent',
        },
      })
      await mountAdmission(harness.ctx, harness.root)
      expect(snapshot(harness)).toMatchObject({
        mode: 'unavailable',
        enforced: false,
        reason: 'bootstrap-live-subagent-present',
      })
    } finally {
      await cleanupHarness(harness)
    }
  })

  scenarioTest('ordinary-parent-fork', async () => {
    const harness = await createHarness({ provider: 'spawn' })
    const ordinaryId = SessionId(`ordinary-${sequence}`)
    const ordinary = await harness.ctx.agents.create({
      sessionId: ordinaryId,
      meta: { parentSession: harness.parent.id },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    })
    try {
      const starting = harness.ctx.subagents.start('spawn', startRequest(ordinary.agent))
      await harness.barriers.beforeProvider.reached
      const observed = snapshot(harness, ordinaryId)
      expect(observed.requestedRootId).toBe(harness.parent.id)
      expect(observed.usage.globalActive).toBe(1)
      harness.barriers.beforeProvider.open()
      const run = await starting
      await harness.barriers.resultSettled.reached
      harness.barriers.resultSettled.open()
      await run.result
      const disposal = run.dispose()
      await harness.barriers.beforeDisposeComplete.reached
      harness.barriers.beforeDisposeComplete.open()
      await disposal
    } finally {
      await ordinary.dispose()
      await cleanupHarness(harness)
    }
  })

  scenarioTest('nested-children', async () => {
    const ancestorBarriers = createLifecycleBarriers()
    const harness = await createHarness({
      provider: 'nested-parent',
      barriers: ancestorBarriers,
    })
    const descendantBarriers = createLifecycleBarriers()
    harness.ctx.subagents.registerProvider(
      new BarrierProvider('nested-child', descendantBarriers),
    )
    const parentTurn = harness.adapter.enqueue()
    const descendantTurn = harness.adapter.enqueue()
    try {
      const ancestorStarting = harness.ctx.subagents.startContinuable({
        provider: 'nested-parent',
        label: 'ancestor',
        request: { prompt: [{ type: 'text', text: 'parent' }], parent: harness.parent },
        signal: new AbortController().signal,
      })
      await ancestorBarriers.beforeMaterialize.reached
      ancestorBarriers.beforeMaterialize.open()
      const ancestor = await ancestorStarting
      await parentTurn.started
      const childAgent = harness.ctx.agents.get(ancestor.childId)
      expect(childAgent).toBeDefined()

      const descendantStarting = harness.ctx.subagents.startContinuable({
        provider: 'nested-child',
        label: 'descendant',
        request: { prompt: [{ type: 'text', text: 'child' }], parent: childAgent! },
        signal: new AbortController().signal,
      })
      await descendantBarriers.beforeMaterialize.reached
      expectStrictUsage(harness, 2, 2)
      descendantBarriers.beforeMaterialize.open()
      await descendantStarting
      await descendantTurn.started
      parentTurn.release()
      await vi.waitFor(() => {
        expect(childAgent?.status).toBe('idle')
        expectStrictUsage(harness, 2, 2)
      })
      descendantTurn.release()
      await waitForActive(harness, 0, 2)
    } finally {
      openAllBarriers(descendantBarriers)
      await cleanupHarness(harness)
    }
  })
})

afterAll(() => {
  for (const missing of REQUIRED_RESULT_IDS.filter((id) => !results.has(id))) {
    results.set(missing, Object.freeze({
      id: missing,
      status: 'fail',
      reason: 'required conformance case did not execute',
      provider: null,
      shape: null,
      scheduling: null,
      entryPoint: null,
      scenario: null,
    }))
  }
  const rows = [...results.values()].sort((left, right) => left.id.localeCompare(right.id))
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(
      join(evidenceDir, 'strict-runtime.json'),
      `${JSON.stringify({ schemaVersion: 1, rows }, null, 2)}\n`,
    )
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})
