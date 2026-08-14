import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'

import { deferred } from './lifecycle-barriers.ts'
import type { Deferred, LifecycleBarriers } from './lifecycle-barriers.ts'

const NO_CAPABILITIES = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/** Controlled one-shot/continuable provider used by the pinned official checkout. */
export class BarrierProvider implements SubagentProvider {
  readonly capabilities = NO_CAPABILITIES
  readonly inheritsParentContext: boolean
  private childCounter = 0

  constructor(
    readonly name: string,
    private readonly barriers: LifecycleBarriers,
    private readonly options: {
      readonly failStart?: Error
      readonly failPrepare?: Error
      readonly failDispose?: Error
    } = {},
  ) {
    this.inheritsParentContext = name === 'fork'
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    await this.barriers.beforeProvider.hold()
    request.signal.throwIfAborted()
    if (this.options.failStart !== undefined) throw this.options.failStart
    const id = SessionId(`${this.name}-one-shot-${++this.childCounter}`)
    const result = (async () => {
      await this.barriers.resultSettled.hold()
      return {
        output: [{ type: 'text' as const, text: `${this.name} completed` }],
        stopReason: 'completed' as const,
      }
    })()
    return {
      id,
      localAgent: undefined,
      result,
      dispose: async (): Promise<void> => {
        await this.barriers.beforeDisposeComplete.hold()
        if (this.options.failDispose !== undefined) throw this.options.failDispose
        this.barriers.finishDisposalComplete.mark()
      },
    }
  }

  async prepareContinuable(
    _request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    await this.barriers.beforeMaterialize.hold()
    if (this.options.failPrepare !== undefined) throw this.options.failPrepare
    return {}
  }
}

interface TurnControl {
  readonly started: Promise<void>
  release(): void
}

/** FIFO model adapter whose turns are individually held after request admission. */
export class ControlledTurnAdapter extends LlmAdapter {
  private readonly controls: Array<{
    readonly started: Deferred<void>
    readonly released: Deferred<void>
  }> = []
  private nextTurn = 0

  enqueue(): TurnControl {
    const started = deferred<void>()
    const released = deferred<void>()
    this.controls.push({ started, released })
    return Object.freeze({
      started: started.promise,
      release: (): void => released.resolve(undefined),
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.nextTurn
    this.nextTurn += 1
    const control = this.controls[index]
    if (control === undefined) {
      throw new Error(`ControlledTurnAdapter has no control for turn ${index}`)
    }
    control.started.resolve(undefined)
    await control.released.promise
    options.signal?.throwIfAborted()
    const text = `turn-${index + 1}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
