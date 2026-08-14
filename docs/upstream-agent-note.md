Status: proposed

# Optional lifecycle-owned subagent admission

## Problem

Under `@deepseek-ai/dsh-subagent`, subagents can be materialized concurrently through built-in tools, external plugins, providers, SDK callers, or direct `ctx.subagents` service calls. Currently, the official runtime provides no centralized, pre-materialization capacity veto. Depth checks bound recursion depth rather than concurrent active breadth or cumulative creation across an entire Host.

When deeply nested subagents expand concurrently (as observed in Discussion #131), uncoordinated callers can allocate excessive concurrent child agents, leading to host resource exhaustion. Tool-local mutexes or per-turn circuit breakers (such as `dsh-turn-budget`) bound specific execution paths or individual agent turns, but cannot enforce an atomic, host-wide decision shared across all callers before provider invocation or Agent construction.

## Alternatives considered

1. **Observe-only lifecycle events (`subagent/start`, `subagent/end`)**: These events notify listeners after lifecycle resources have already been allocated or published. They cannot veto materialization or prevent resource exhaustion before provider work begins.
2. **Cordis waterfall (`subagent/admit`)**: A waterfall hook style fails to provide safe lifecycle ownership. If the last listener unloads, the chain defaults to fail-open without a persistent guard. Furthermore, waterfall hooks do not cleanly pass and hold a lifecycle permit across asynchronous provider execution, long-lived resident states, and eventual quiescence.
3. **Child setup hook (`registerContinuableSetup`)**: This hook executes child-scoped capability configuration during continuable Agent construction. It does not cover one-shot starts and does not act as a pre-materialization capacity gate before resource allocation.
4. **Separate `ctx.subagentAdmission` service**: While making Service Definition, Provider, and Consumer boundaries explicit, a separate service introduces additional context keys, bootstrap ordering dependencies, and lifecycle synchronization challenges without solving permit handoff.

## Decision

Extend `SubagentRuntime` as the **Service Definition** and **Consumer**, allowing an external plugin to act as the **Provider** by registering an optional admission policy:

```ts
runtime.registerAdmissionPolicy(policy)
```

The runtime consults the registered policy before any child execution or Agent materialization. If accepted, the policy issues a permit. The runtime binds the official child identity upon publication and retains the permit until canonical quiescence or startup rollback.

The proposal asks for a narrow, documented extension point in core DSH, not an upstream quota product. The official runtime remains unopinionated: it contains no quotas, durable storage, telemetry, or user interfaces.

## Protocol

The detached protocol v1 contract is defined as follows:

```ts
export type SubagentAdmissionOperationV1 =
  | 'new-one-shot'
  | 'new-continuable'
  | 'cold-resume'

export interface SubagentAdmissionRequestV1 {
  readonly requestId: string
  readonly operation: SubagentAdmissionOperationV1
  readonly provider: string
  readonly parentSessionId: string
  readonly childSessionId?: string
}

export interface SubagentAdmissionChildBindingV1 {
  readonly childSessionId: string
  readonly localParentSessionId?: string
}

export type SubagentAdmissionReleaseReasonV1 =
  | 'startup-failed'
  | 'quiescent'

export interface SubagentAdmissionPermitV1 {
  bindChild(binding: SubagentAdmissionChildBindingV1): void
  release(reason: SubagentAdmissionReleaseReasonV1): Promise<void>
}

export interface SubagentAdmissionPolicyV1 {
  readonly protocolVersion: 1
  acquire(
    request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1>
}
```

`SubagentRuntime` exposes:

```ts
readonly admissionProtocolVersion = 1
registerAdmissionPolicy(policy: SubagentAdmissionPolicyV1): () => void
```

Registration rules:
- Only one policy may be registered. Duplicate registration throws `DUPLICATE_ADMISSION_POLICY`.
- Registering an unsupported protocol throws `UNSUPPORTED_ADMISSION_PROTOCOL`.
- Unregistering disposes the active policy into a permanent **tombstone** (`ADMISSION_CLOSED`). Subsequent materialization attempts fail closed rather than silently bypassing admission. Hot replacement is intentionally disallowed in protocol v1 to prevent capacity leakage while prior permits remain active; recovering requires a fresh runtime instance.

## Lifecycle boundaries

The runtime coordinates admission across five distinct execution boundaries:

| Operation | Acquire boundary | Bind boundary | Release boundary |
| --- | --- | --- | --- |
| `new-one-shot` | After provider/capability validation; before `provider.start()` | After provider publication; before caller return | After memoized `run.dispose()` proves quiescence |
| `new-continuable` | After child ID reservation and validation; before `prepareContinuable()` / Agent materialization | After Activation publication; before child execution | Startup rollback (`startup-failed`) or canonical Activation disposal (`quiescent`) |
| `cold-resume` | After descriptor and parent lineage validation; before Agent resume | After Activation publication | Startup rollback (`startup-failed`) or canonical Activation disposal (`quiescent`) |
| Resident follow-up | No acquisition | No rebinding | Reuses existing resident Activation permit |
| Descendant teardown | No acquisition | None | Descendant releases permit child-first before parent ownership wake |

When no policy is registered, the one-shot path returns the original provider run directly with zero overhead.

## Cancellation and failure semantics

Admission and cancellation are strictly coordinated to prevent capacity leaks:

1. **Cancellation during acquisition**: The caller's `AbortSignal` is passed directly to `acquire(request, signal)`. If the signal triggers or is aborted before provider work begins, the runtime releases the newly issued permit with `startup-failed` and does not invoke the provider.
2. **Cancellation after publication**: If cancellation occurs after the child is published, the runtime executes the official rollback and disposal path first. Only after cleanup completes does it call `release('startup-failed')`.
3. **Cleanup integrity**: If official cleanup fails or permit release fails, the permit remains held. Protocol v1 defines no forced release, ensuring uncertainty is never converted into false capacity claims.

## Testing

The seam design is verified against exact official source commit `47f943859bef60e4160492346772ded9b24f765a` (`@deepseek-ai/dsh-subagent@0.1.0-rc.5`).

The test suite includes:
- 249 stock official subagent tests plus 21 injected reusable admission-fixture tests, all passing (270 tests across 11 files).
- The reusable fixture covers single registration, tombstoning, fail-closed unregistration, pre-provider acquisition, publication binding, post-quiescence release, startup rollback, one-shot and cold-resume cancellation propagation, resident follow-up reuse, cold resume admission, and descendant-first teardown ordering.

## Consequences

- **Separation of concerns**: DeepSeek Harness core remains lightweight, clean, and unopinionated while providing a robust lifecycle hook for advanced resource management plugins.
- **Cross-caller consistency**: All subagent creation paths—whether from tools, background plugins, or direct SDK calls—share one coherent admission authority.
- **Non-trivial implementation**: Although the public protocol is minimal, integrating lifecycle-correct ownership requires precision across one-shot execution, continuable activation, and asynchronous cleanup. In the qualified candidate, the patch touches 3 official files (`types.ts`, `index.ts`, `continuation.ts`) with 230 total changed lines (106 in `continuation.ts`).
- **Productization gate**: Achieving a documented official extension point enables **zero-patch Strict** enforcement for community plugins without requiring local source patching.

## Deferred work

- Multi-generation policy replacement and graceful drain barriers.
- Distributed or multi-host admission coordination.
- Priority queuing and preemptive subagent cancellation.
