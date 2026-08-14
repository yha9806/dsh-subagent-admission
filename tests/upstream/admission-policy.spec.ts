import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, {
  type ContinuableCreateRequest,
  type ContinuableCreateSpec,
  type ResolvedSubagentStartRequest,
  type SubagentAdmissionChildBindingV1,
  type SubagentAdmissionPermitV1,
  type SubagentAdmissionPolicyV1,
  type SubagentAdmissionRequestV1,
  type SubagentProvider,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

import {
  MockAdapter,
  textResponse,
} from '../../../core/agent-loop/tests/mock-adapter.ts'

type SeamShape = 'reference' | 'slim'

const SEAM_SHAPE: SeamShape | undefined = process.env.DSH_ADMISSION_SEAM_SHAPE as
  | SeamShape
  | undefined
if (SEAM_SHAPE !== 'reference' && SEAM_SHAPE !== 'slim') {
  throw new Error(
    'DSH_ADMISSION_SEAM_SHAPE must be reference or slim',
  )
}

type ObservedReleaseReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'disposed'
  | 'startup-failed'
  | 'quiescent'

const admissionEvent = (operation: string): string =>
  (SEAM_SHAPE === 'slim' ? 'acquire:' : 'prepare:') + operation

const quiescentReason: ObservedReleaseReason =
  SEAM_SHAPE === 'slim' ? 'quiescent' : 'disposed'

const NO_CAPABILITIES = {
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
} as const

interface PermitRecord {
  readonly request: SubagentAdmissionRequestV1
  readonly signal: AbortSignal | undefined
  readonly entry: 'prepare' | 'acquire'
  readonly bindings: SubagentAdmissionChildBindingV1[]
  readonly releases: ObservedReleaseReason[]
}

class RecordingPolicy implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const
  readonly records: PermitRecord[] = []

  constructor(
    private readonly events: string[] = [],
    private readonly releaseOrder: string[] = [],
  ) {}

  async prepare(
    request: SubagentAdmissionRequestV1,
  ): Promise<SubagentAdmissionPermitV1> {
    return this.issue(request, undefined, 'prepare')
  }

  async acquire(
    request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> {
    return this.issue(request, signal, 'acquire')
  }

  private async issue(
    request: SubagentAdmissionRequestV1,
    signal: AbortSignal | undefined,
    entry: 'prepare' | 'acquire',
  ): Promise<SubagentAdmissionPermitV1> {
    const record: PermitRecord = {
      request,
      signal,
      entry,
      bindings: [],
      releases: [],
    }
    this.records.push(record)
    this.events.push(entry + ':' + request.operation)
    return {
      bindChild: (binding): void => {
        record.bindings.push(binding)
        this.events.push('bind:' + binding.childSessionId)
      },
      release: async (reason): Promise<void> => {
        record.releases.push(reason)
        this.releaseOrder.push(
          request.childSessionId ?? request.parentSessionId,
        )
        this.events.push('release:' + reason)
      },
    }
  }
}

class UnsupportedProtocolPolicy {
  readonly protocolVersion = 2 as const

  async prepare(): Promise<never> {
    throw new Error('must not prepare')
  }

  async acquire(): Promise<never> {
    throw new Error('must not acquire')
  }
}

class RejectBindingPolicy implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const

  constructor(private readonly events: string[]) {}

  async prepare(
    _request: SubagentAdmissionRequestV1,
  ): Promise<SubagentAdmissionPermitV1> {
    return this.issue()
  }

  async acquire(
    _request: Readonly<SubagentAdmissionRequestV1>,
    _signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> {
    return this.issue()
  }

  private issue(): SubagentAdmissionPermitV1 {
    return {
      bindChild: (): never => {
        this.events.push('bind-rejected')
        throw new Error('binding rejected')
      },
      release: async (reason): Promise<void> => {
        this.events.push(`release:${reason}`)
      },
    }
  }
}

class ExactSignalPolicy implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const

  constructor(private readonly onSignal: (signal: AbortSignal) => void) {}

  async prepare(): Promise<never> {
    throw new Error('reference-only method must stay skipped')
  }

  async acquire(
    _request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> {
    this.onSignal(signal)
    return {
      bindChild: (): void => {},
      release: async (): Promise<void> => {},
    }
  }
}

class CancelAfterAcquirePolicy implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const

  constructor(
    private readonly controller: AbortController,
    private readonly events: string[],
  ) {}

  async prepare(): Promise<never> {
    throw new Error('reference-only method must stay skipped')
  }

  async acquire(
    _request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> {
    expect(signal).toBe(this.controller.signal)
    this.events.push('acquire')
    this.controller.abort()
    return {
      bindChild: (): void => {
        this.events.push('bind')
      },
      release: async (reason): Promise<void> => {
        this.events.push('release:' + reason)
      },
    }
  }
}

class AbortDuringPublicationPolicy implements SubagentAdmissionPolicyV1 {
  readonly protocolVersion = 1 as const

  constructor(
    private readonly controller: AbortController,
    private readonly events: string[],
  ) {}

  async prepare(): Promise<never> {
    throw new Error('reference-only method must stay skipped')
  }

  async acquire(
    _request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> {
    expect(signal).toBe(this.controller.signal)
    this.events.push('acquire')
    return {
      bindChild: (): void => {
        this.events.push('bind')
        this.controller.abort()
      },
      release: async (reason): Promise<void> => {
        this.events.push('release:' + reason)
      },
    }
  }
}

function fakeParent(id = 'parent'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function oneShotRequest(
  parent = fakeParent(),
  overrides: Partial<SubagentStartRequest> = {},
): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'delegate this' }],
    parent,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function remoteRun(
  id: string,
  dispose: () => Promise<void> = async () => {},
): SubagentRun {
  return {
    id: SessionId(id),
    localAgent: undefined,
    result: Promise.resolve({
      output: [{ type: 'text', text: 'done' }],
      stopReason: 'completed',
    }),
    dispose,
  }
}

async function bareRuntime(): Promise<{
  readonly ctx: Context
  readonly runtime: SubagentRuntime
}> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  return { ctx, runtime: ctx.subagents }
}

function registerOneShotProvider(
  runtime: SubagentRuntime,
  name: string,
  start: (request: ResolvedSubagentStartRequest) => Promise<SubagentRun>,
): void {
  runtime.registerProvider({
    name,
    capabilities: NO_CAPABILITIES,
    inheritsParentContext: false,
    start,
  })
}

describe('SubagentRuntime protocol-v1 admission registration', () => {
  it('exposes an explicit protocol and permanently tombstones after unregister', async () => {
    const { runtime } = await bareRuntime()
    const first = new RecordingPolicy()

    expect(runtime.admissionProtocolVersion).toBe(1)
    const unregister = runtime.registerAdmissionPolicy(first)
    expect(() => runtime.registerAdmissionPolicy(new RecordingPolicy()))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_ADMISSION_POLICY' }))

    unregister()
    expect(() => runtime.registerAdmissionPolicy(new RecordingPolicy()))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_ADMISSION_POLICY' }))
  })

  it('rejects a policy whose explicit protocol is not version 1', async () => {
    const { runtime } = await bareRuntime()
    const unsupported = new UnsupportedProtocolPolicy()

    expect(() => runtime.registerAdmissionPolicy(unsupported as never))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ADMISSION_PROTOCOL' }))
  })
})

describe('one-shot admission ownership', () => {
  it('admits before provider startup, binds publication, and releases after quiescence', async () => {
    const { runtime } = await bareRuntime()
    const events: string[] = []
    const policy = new RecordingPolicy(events)
    runtime.registerAdmissionPolicy(policy)
    const disposeGate = Promise.withResolvers<void>()
    const parent = fakeParent('root-parent')
    const childId = SessionId('local-child')
    const localAgent = {
      id: childId,
      session: {
        header: {
          id: childId,
          parentSession: parent.id,
          origin: 'subagent',
        },
      },
    } as unknown as Agent
    registerOneShotProvider(runtime, 'spawn', async () => {
      events.push('provider')
      return {
        id: childId,
        localAgent,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async (): Promise<void> => {
          events.push('provider-dispose-start')
          await disposeGate.promise
          events.push('provider-dispose-end')
        },
      }
    })

    const run = await runtime.start('spawn', oneShotRequest(parent))

    expect(events.slice(0, 3)).toEqual([
      admissionEvent('new-one-shot'),
      'provider',
      'bind:local-child',
    ])
    expect(policy.records[0]?.request).toMatchObject({
      operation: 'new-one-shot',
      provider: 'spawn',
      parentSessionId: 'root-parent',
    })
    expect(policy.records[0]?.request.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.keys(policy.records[0]!.request).sort()).toEqual([
      'operation',
      'parentSessionId',
      'provider',
      'requestId',
    ])
    expect(policy.records[0]?.bindings).toEqual([{
      childSessionId: 'local-child',
      localParentSessionId: 'root-parent',
    }])

    // Result settlement is not release evidence.
    await run.result
    expect(policy.records[0]?.releases).toEqual([])
    const disposing = run.dispose()
    await vi.waitFor(() => {
      expect(events).toContain('provider-dispose-start')
    })
    expect(policy.records[0]?.releases).toEqual([])
    disposeGate.resolve()
    await disposing
    await run.dispose()
    expect(events.slice(-2)).toEqual([
      'provider-dispose-end',
      `release:${quiescentReason}`,
    ])
    expect(policy.records[0]?.releases).toEqual([quiescentReason])
  })

  it('releases a charged permit only after provider rejection cleanup', async () => {
    const { runtime } = await bareRuntime()
    const events: string[] = []
    const policy = new RecordingPolicy(events)
    runtime.registerAdmissionPolicy(policy)
    registerOneShotProvider(runtime, 'failed', async () => {
      events.push('provider-cleaned')
      throw new Error('provider rejected after cleanup')
    })

    await expect(runtime.start('failed', oneShotRequest()))
      .rejects.toThrow('provider rejected after cleanup')
    expect(events).toEqual([
      admissionEvent('new-one-shot'),
      'provider-cleaned',
      'release:startup-failed',
    ])
  })

  it('retains capacity when disposal cannot prove quiescence', async () => {
    const { runtime } = await bareRuntime()
    const policy = new RecordingPolicy()
    runtime.registerAdmissionPolicy(policy)
    const dispose = vi.fn(async (): Promise<never> => {
      throw new Error('cleanup did not reach quiescence')
    })
    registerOneShotProvider(
      runtime,
      'unclean',
      async () => remoteRun('unclean-child', dispose),
    )

    const run = await runtime.start('unclean', oneShotRequest())
    await expect(run.dispose()).rejects.toThrow('cleanup did not reach quiescence')
    await expect(run.dispose()).rejects.toThrow('cleanup did not reach quiescence')

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(policy.records[0]?.releases).toEqual([])
  })

  it('cleans a published run before releasing when child binding fails', async () => {
    const { runtime } = await bareRuntime()
    const events: string[] = []
    const policy = new RejectBindingPolicy(events)
    runtime.registerAdmissionPolicy(policy)
    registerOneShotProvider(runtime, 'binding', async () => ({
      ...remoteRun('binding-child'),
      dispose: async (): Promise<void> => {
        events.push('provider-disposed')
      },
    }))

    await expect(runtime.start('binding', oneShotRequest()))
      .rejects.toThrow('binding rejected')
    expect(events).toEqual([
      'bind-rejected',
      'provider-disposed',
      'release:startup-failed',
    ])
  })

  it('retains capacity when binding rollback cannot quiesce the child', async () => {
    const { runtime } = await bareRuntime()
    const events: string[] = []
    runtime.registerAdmissionPolicy(new RejectBindingPolicy(events))
    registerOneShotProvider(runtime, 'unclean-binding', async () => ({
      ...remoteRun('unclean-binding-child'),
      dispose: async (): Promise<never> => {
        events.push('provider-dispose-failed')
        throw new Error('child did not quiesce')
      },
    }))

    await expect(runtime.start('unclean-binding', oneShotRequest()))
      .rejects.toThrow('subagent child binding and publication rollback both failed')
    expect(events).toEqual([
      'bind-rejected',
      'provider-dispose-failed',
    ])
  })

  it('keeps outstanding permits releasable after registration is tombstoned', async () => {
    const { runtime } = await bareRuntime()
    const policy = new RecordingPolicy()
    const unregister = runtime.registerAdmissionPolicy(policy)
    const firstRaw = remoteRun('first')
    let starts = 0
    registerOneShotProvider(runtime, 'spawn', async () => {
      starts += 1
      return firstRaw
    })

    const first = await runtime.start('spawn', oneShotRequest())
    unregister()

    await expect(runtime.start('spawn', oneShotRequest()))
      .rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
    expect(starts).toBe(1)
    expect(policy.records).toHaveLength(1)
    await first.dispose()
    expect(policy.records[0]?.releases).toEqual([quiescentReason])
  })

  it('returns the original provider run unchanged when no policy is registered', async () => {
    const { runtime } = await bareRuntime()
    const raw = remoteRun('stock-child')
    registerOneShotProvider(runtime, 'stock', async () => raw)

    await expect(runtime.start('stock', oneShotRequest())).resolves.toBe(raw)
  })

  it.each([
    ['spawn', 'foreground'],
    ['spawn', 'background'],
    ['fork', 'foreground'],
    ['fork', 'background'],
  ] as const)(
    'uses the same permit lifecycle for %s %s ownership',
    async (provider, scheduling) => {
      const { runtime } = await bareRuntime()
      const policy = new RecordingPolicy()
      runtime.registerAdmissionPolicy(policy)
      registerOneShotProvider(
        runtime,
        provider,
        async () => remoteRun(`${provider}-${scheduling}`),
      )

      const run = await runtime.start(provider, oneShotRequest())
      if (scheduling === 'foreground') {
        await run.result
      }
      await run.dispose()

      expect(policy.records).toHaveLength(1)
      expect(policy.records[0]).toMatchObject({
        request: { operation: 'new-one-shot', provider },
        releases: [quiescentReason],
      })
    },
  )

  it.skipIf(SEAM_SHAPE === 'reference')(
    'passes the exact caller signal to policy acquisition',
    async () => {
      const { runtime } = await bareRuntime()
      const controller = new AbortController()
      let observedSignal: AbortSignal | undefined
      runtime.registerAdmissionPolicy(
        new ExactSignalPolicy((signal) => {
          observedSignal = signal
        }),
      )
      registerOneShotProvider(runtime, 'spawn', async () => remoteRun('child'))

      const run = await runtime.start(
        'spawn',
        oneShotRequest(fakeParent(), { signal: controller.signal }),
      )
      expect(observedSignal).toBe(controller.signal)
      await run.dispose()
    },
  )

  it.skipIf(SEAM_SHAPE === 'reference')(
    'releases after cancellation wins following acquire and starts no provider',
    async () => {
      const { runtime } = await bareRuntime()
      const controller = new AbortController()
      const events: string[] = []
      let starts = 0
      runtime.registerAdmissionPolicy(
        new CancelAfterAcquirePolicy(controller, events),
      )
      registerOneShotProvider(runtime, 'spawn', async () => {
        starts += 1
        return remoteRun('never-started')
      })

      await expect(runtime.start(
        'spawn',
        oneShotRequest(fakeParent(), { signal: controller.signal }),
      )).rejects.toMatchObject({ name: 'AbortError' })
      expect(starts).toBe(0)
      expect(events).toEqual(['acquire', 'release:startup-failed'])
    },
  )

  it.skipIf(SEAM_SHAPE === 'reference')(
    'rolls back a published provider run before releasing when caller cancellation wins during publication',
    async () => {
      const { runtime } = await bareRuntime()
      const controller = new AbortController()
      const events: string[] = []
      runtime.registerAdmissionPolicy(
        new AbortDuringPublicationPolicy(controller, events),
      )
      registerOneShotProvider(runtime, 'spawn', async () => {
        events.push('provider')
        return {
          ...remoteRun('aborted-child'),
          dispose: async (): Promise<void> => {
            events.push('provider-disposed')
          },
        }
      })

      await expect(runtime.start(
        'spawn',
        oneShotRequest(fakeParent(), { signal: controller.signal }),
      )).rejects.toMatchObject({ name: 'AbortError' })
      expect(events).toEqual([
        'acquire',
        'provider',
        'bind',
        'provider-disposed',
        'release:startup-failed',
      ])
    },
  )
})

interface GatedEntry {
  readonly chunks: StreamChunk[]
  readonly gate?: Promise<void>
}

class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) {
      throw new Error('GatedAdapter script exhausted')
    }
    await entry.gate
    for (const chunk of entry.chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function continuationRuntime(adapter: LlmAdapter): Promise<{
  readonly ctx: Context
  readonly parent: Agent
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-admission-policy-'))
  temporaryRoots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
  )
  parkParent(ctx, parent)
  return { ctx, parent }
}

function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent !== parent) return next()
    return { kind: 'reject' as const }
  })
}

function registerContinuableProvider(
  ctx: Context,
  name: string,
  prepare: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>,
): void {
  const provider: SubagentProvider = {
    name,
    capabilities: NO_CAPABILITIES,
    inheritsParentContext: false,
    start: async (): Promise<never> => {
      throw new Error('continuable test provider must not run one-shot start')
    },
    prepareContinuable: prepare,
  }
  ctx.subagents.registerProvider(provider)
}

function continuableSpec(parent: Agent, provider = 'continuable') {
  const signal = new AbortController().signal
  return {
    provider,
    label: 'background child',
    request: {
      prompt: [{ type: 'text' as const, text: 'work' }],
      parent,
    },
    signal,
  }
}

function followup(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  text: string,
): Promise<string> {
  return ctx.subagents.followup(
    parent,
    childId,
    [{ type: 'text', text }],
    {
      source: { kind: 'user' },
      signal: new AbortController().signal,
    },
  )
}

async function waitNoActivation(
  ctx: Context,
  childId: SessionId,
): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('continuable admission ownership', () => {
  it('admits fresh and cold materialization but not resident follow-up', async () => {
    const firstTurn = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: firstTurn.promise },
      { chunks: textResponse('resident') },
      { chunks: textResponse('cold') },
    ])
    const { ctx, parent } = await continuationRuntime(adapter)
    const order: string[] = []
    registerContinuableProvider(ctx, 'continuable', async () => {
      order.push('provider')
      return {}
    })
    const policy = new RecordingPolicy(order)
    ctx.subagents.registerAdmissionPolicy(policy)
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) order.push('materialize')
    })

    const started = await ctx.subagents.startContinuable(
      continuableSpec(parent),
    )
    expect(order.slice(0, 4)).toEqual([
      admissionEvent('new-continuable'),
      'provider',
      'materialize',
      `bind:${started.childId}`,
    ])
    expect(policy.records[0]?.request).toMatchObject({
      operation: 'new-continuable',
      provider: 'continuable',
      parentSessionId: 'parent',
      childSessionId: started.childId,
    })
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
    })

    await followup(ctx, parent, started.childId, 'while resident')
    expect(policy.records).toHaveLength(1)
    firstTurn.resolve()
    await waitNoActivation(ctx, started.childId)
    expect(policy.records[0]?.releases).toEqual([quiescentReason])

    await followup(ctx, parent, started.childId, 'cold resume')
    expect(policy.records).toHaveLength(2)
    expect(policy.records[1]?.request).toMatchObject({
      operation: 'cold-resume',
      provider: 'continuable',
      parentSessionId: 'parent',
      childSessionId: started.childId,
    })
    await waitNoActivation(ctx, started.childId)
    expect(policy.records[1]?.releases).toEqual([quiescentReason])
  })

  it('releases fresh admission after provider preparation rejects', async () => {
    const { ctx, parent } = await continuationRuntime(new MockAdapter([]))
    const events: string[] = []
    registerContinuableProvider(ctx, 'failed', async () => {
      events.push('provider-cleaned')
      throw new Error('preparation rejected')
    })
    const policy = new RecordingPolicy(events)
    ctx.subagents.registerAdmissionPolicy(policy)

    await expect(
      ctx.subagents.startContinuable(continuableSpec(parent, 'failed')),
    ).rejects.toThrow('preparation rejected')
    expect(events).toEqual([
      admissionEvent('new-continuable'),
      'provider-cleaned',
      'release:startup-failed',
    ])
    expect(ctx.agents.list().map((agent) => agent.id)).toEqual([parent.id])
  })

  it('holds an ancestor permit until descendant-first disposal completes', async () => {
    const parentTurn = Promise.withResolvers<void>()
    const descendantTurn = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: parentTurn.promise },
      { chunks: textResponse('descendant'), gate: descendantTurn.promise },
    ])
    const { ctx, parent } = await continuationRuntime(adapter)
    registerContinuableProvider(ctx, 'continuable', async () => ({}))
    const releaseOrder: string[] = []
    const policy = new RecordingPolicy([], releaseOrder)
    ctx.subagents.registerAdmissionPolicy(policy)

    const ancestor = await ctx.subagents.startContinuable(
      continuableSpec(parent),
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
    })
    const childAgent = ctx.agents.get(ancestor.childId)
    expect(childAgent).toBeDefined()
    const descendant = await ctx.subagents.startContinuable(
      continuableSpec(childAgent!),
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
    })

    parentTurn.resolve()
    await vi.waitFor(() => {
      expect(childAgent?.status).toBe('idle')
      expect(ctx.agents.get(ancestor.childId)).toBe(childAgent)
    })
    expect(policy.records[0]?.releases).toEqual([])

    descendantTurn.resolve()
    await waitNoActivation(ctx, descendant.childId)
    await waitNoActivation(ctx, ancestor.childId)
    expect(releaseOrder).toEqual([
      descendant.childId,
      ancestor.childId,
    ])
  })

  it('releases cold-resume admission after materialization rollback', async () => {
    const { ctx, parent } = await continuationRuntime(
      new MockAdapter([textResponse('initial')]),
    )
    registerContinuableProvider(ctx, 'continuable', async () => ({}))
    const started = await ctx.subagents.startContinuable(
      continuableSpec(parent),
    )
    await waitNoActivation(ctx, started.childId)
    const policy = new RecordingPolicy()
    ctx.subagents.registerAdmissionPolicy(policy)
    const resume = vi.spyOn(ctx.agents, 'resume')
      .mockRejectedValue(new Error('resume rolled back'))

    try {
      await expect(
        followup(ctx, parent, started.childId, 'resume'),
      ).rejects.toThrow(/unavailable/)
    } finally {
      resume.mockRestore()
    }
    expect(policy.records).toHaveLength(1)
    expect(policy.records[0]).toMatchObject({
      request: {
        operation: 'cold-resume',
        childSessionId: started.childId,
      },
      releases: ['startup-failed'],
    })
  })
})
