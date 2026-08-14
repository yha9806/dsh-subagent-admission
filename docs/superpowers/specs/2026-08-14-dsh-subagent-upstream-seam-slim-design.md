# DSH Subagent Upstream Admission Seam Slim Design

Status: implemented and requalified; the public reply was authorized separately

Date: 2026-08-14

## Post-qualification slimming decision

The implemented candidate was re-reviewed after the public design question was
posted. Three directions were compared:

1. **Preserve the lifecycle-correct candidate and slim the official-facing
   packet** — selected. The patch remains a non-trivial integration vehicle;
   the maintainers are asked to judge only registration plus acquire, bind, and
   release ownership edges.
2. **Delete rollback, cancellation, tombstone, or failure aggregation to reduce
   source lines** — rejected. These are enforcement semantics, not product
   policy, and removing them would create fail-open or false-release paths.
3. **Replace the concrete subagent seam with a generic runtime resource-permit
   service** — deferred. No second independent consumer currently justifies a
   broader official abstraction.

The review found one real semantic gap: cold-resume cancellation could win
after `acquire()` but before ownership transferred to `materialize()`, leaving
the permit unreleased. A RED fixture reproduced the missing
`release('startup-failed')`; the minimal ownership-transfer fix then passed 270
tests across 11 files on the exact official target. The requalified candidate
is 230 changed lines across three official files, including 106 in
`continuation.ts`, and 455 serialized patch lines. Further line shaving is not
an acceptance goal unless it preserves every lifecycle gate below.

## 1. Purpose

This document is the approved delta design for two related deliverables:

1. an official-facing design package that asks DeepSeek Harness maintainers one
   narrow extension-point question; and
2. an executable slim-patch candidate that must preserve the current reference
   patch's lifecycle correctness while materially reducing its official-source
   footprint.

It refines, rather than replaces, the broader product design in
`2026-08-13-dsh-subagent-admission-design.md`. The external product remains an
Agent Runtime Resource Control Plane whose current v0.1 wedge is DSH subagent
admission. This delta concerns only the official runtime extension point and
its conformance evidence.

The current 607-line patch remains the verified reference implementation until
the slim candidate passes every semantic and size gate in this document. No
line-count target may weaken rollback, quiescence, cancellation, lineage, or
fail-closed behavior.

## 2. Current facts and problem boundary

The exact official source target is commit
`47f943859bef60e4160492346772ded9b24f765a`. At that target:

- `SubagentRuntime.start()` is the central one-shot entry point;
- the continuation manager owns fresh continuable creation, cold resume,
  resident follow-up, Activation residency, descendant ownership, and
  child-first disposal;
- `subagent/start` and `subagent/end` are deliberately observe-only;
- `registerContinuableSetup()` installs child-scoped capabilities during
  continuable Agent construction, does not cover one-shot starts, and is not a
  pre-materialization capacity gate; and
- lifecycle control remains package-private because the continuation manager,
  not an external listener, owns authoritative cleanup ordering.

The existing reference patch modifies three official files:

| File | Insertions | Deletions | Changed lines |
| --- | ---: | ---: | ---: |
| `src/continuation.ts` | 151 | 36 | 187 |
| `src/index.ts` | 181 | 2 | 183 |
| `src/types.ts` | 48 | 0 | 48 |
| **Total** | **380** | **38** | **418** |

The serialized patch is 607 lines. This is a non-trivial lifecycle integration,
not a claim that admission can be implemented as a few incidental hooks.

The residual problem is one atomic authority shared by every caller that uses
`ctx.subagents`: built-in tools, external plugins, providers, SDK callers, and
direct service calls. It must decide before provider execution or Agent
materialization and retain capacity until the official lifecycle proves
quiescence. Tool-local locks, per-turn circuit breakers, team-member caps, and
post-publication telemetry remain useful but do not provide this Host-wide
boundary.

## 3. Architectural alternatives

### 3.1 Registration on `SubagentRuntime` -- selected

`ctx.subagents.registerAdmissionPolicy(policy)` extends the existing subagent
Service Definition. An external plugin supplies the policy; the one-shot and
continuation runtimes consume it while retaining lifecycle ownership.

This shape is selected because it:

- reuses the existing `ctx.subagents` capability seam instead of adding a
  second runtime or context key;
- gives the runtime exact knowledge of policy registration and removal;
- supports one process-wide authority without ambiguous listener composition;
- lets the runtime hold returned permits on `SubagentRun` or Activation
  ownership paths; and
- matches registry-style extension points already used by DSH capability
  families.

The official patch defines no quota, root resolver, durable ledger, telemetry,
GUI, scheduler, or queue. Those stay in the external plugin.

### 3.2 Cordis waterfall -- rejected

A `subagent/admit` waterfall initially appears close to DSH's policy-event
style, but it does not safely express this authority:

- when the last listener unloads, the default chain would silently return to
  allow unless another sticky gate is added;
- a waterfall result would need to carry a permit beyond the intercepted call
  and through later canonical cleanup;
- multiple listeners would need an explicit composite-permit protocol; and
- making the listener wrap a returned run would expose lifecycle ownership to
  the wrong layer.

Adding registration state and lifecycle transfer to repair these issues would
recreate the selected design with more machinery.

### 3.3 Separate `ctx.subagentAdmission` Service -- deferred

A separate Cordis Service would make Service Definition, Provider, and Consumer
roles visually explicit, but it adds another context key, package boundary,
boot-order dependency, and service-removal problem. It does not by itself solve
fail-open absence or permit handoff.

The existing `SubagentRuntime` is already the lifecycle authority and the right
consumer. A separate service can be reconsidered only if another independent
consumer appears and justifies the extra seam.

## 4. Protocol v1

### 4.1 Public contract

The slim candidate exports the following semantic surface. Exact formatting may
follow official source style, but behavior may not differ.

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

`SubagentRuntime` exposes only:

```ts
readonly admissionProtocolVersion = 1
registerAdmissionPolicy(policy: SubagentAdmissionPolicyV1): () => void
```

### 4.2 Contract rationale

- `acquire` names resource ownership directly and cannot be confused with
  provider `prepareContinuable`.
- The runtime-generated `requestId` correlates denial, lease, audit, and
  operator evidence without exposing a runtime object.
- `AbortSignal` is separate from the frozen primitive metadata. Authorities
  that await lineage or ledger I/O must be able to observe caller
  cancellation.
- `childSessionId` is absent for a new one-shot before provider publication,
  present for a reserved continuable child, and present for cold resume.
- `localParentSessionId` is optional because remote one-shot providers may have
  no local child Session. When present, it checks provider publication against
  the parent authority used at acquisition. It is consistency evidence only;
  it must never authorize a root-cache or lineage-inspection bypass.
- `bindChild()` is synchronous. An asynchronous bind would introduce a window
  in which the official child exists but policy ownership is unresolved.
- `release()` is asynchronous because lease and durable-state cleanup may
  require I/O. The runtime awaits it inside the canonical disposal transaction.
- The official runtime can certify only startup rollback or quiescent cleanup.
  It therefore exposes `startup-failed` and `quiescent`, not result-level
  labels such as completed, aborted, or error.

Requests and bindings contain no `Agent`, `AgentHandle`, prompt, model output,
tool arguments, provider object, root assertion, result, credentials, or
disposal authority.

## 5. Policy registration state

The implementation may use a tri-state field:

```text
undefined  optional: no policy has ever been registered
policy     active: every materializing path must acquire
null       closed: a prior active policy was removed
```

The required transitions are:

| State | Input | Outcome |
| --- | --- | --- |
| `optional` | no policy | preserve stock behavior |
| `optional` | register protocol v1 | enter `active` |
| `optional` | register unsupported protocol | fail loud; remain `optional` |
| `active` | register another policy | `DUPLICATE_ADMISSION_POLICY` |
| `active` | registration effect disposes | enter permanent `closed` |
| `closed` | any new materialization | `ADMISSION_CLOSED` |
| `closed` | register a replacement policy | reject; require a fresh runtime |

Outstanding permits remain releasable after the registration enters `closed`.
Removal revokes the ability to acquire; it does not revoke already-transferred
ownership.

### 5.1 Why v1 does not hot-reload a policy

Immediate replacement is unsafe while old permits may still exist. A new policy
could see no process-local active leases, admit against an artificially empty
count, and exceed global or root capacity while old-generation children remain
live.

A future safe replacement protocol requires at least:

- policy generation identity;
- runtime-visible outstanding-permit accounting;
- old-to-new lease handoff or a shared active-state authority;
- a quiescent drain barrier; and
- fail-closed recovery when handoff is incomplete.

Those concerns are deliberately excluded from protocol v1. A fresh
`SubagentRuntime` is the explicit recovery boundary.

## 6. Permit ownership and failure semantics

### 6.1 Permit states

| State | Allowed transition | Meaning |
| --- | --- | --- |
| held, unbound | bind or startup-failed release | capacity accepted before publication |
| held, bound | quiescent release | official child identity published |
| releasing | await policy cleanup | release is not yet evidence |
| released | idempotent duplicate handling belongs to policy | capacity no longer active |
| release-failed | remain held and report failure | v1 has no force release |

The policy may make identical bind/release calls idempotent, but conflicting
bindings fail loud. The runtime must not depend on duplicate calls for normal
operation because one-shot and Activation disposal are memoized.

### 6.2 Startup failure

If failure occurs before any child resource exists, the runtime releases the
permit with `startup-failed` and preserves the startup error. If release also
fails, both failures remain observable.

If a run or Activation has already published, the runtime first executes the
existing rollback/disposal path. It calls `release('startup-failed')` only after
that cleanup succeeds. If cleanup cannot prove quiescence, the permit remains
held; a force release would turn uncertainty into a false capacity claim.

### 6.3 Quiescent release

One-shot capacity remains held through result settlement and releases only
after the returned run's memoized `dispose()` completes. A result is not
resource-release evidence.

Continuable capacity remains on the Activation through running, idle, waiting,
accepted inbox work, and owned descendants. Child-first disposal completes
descendant cleanup, Agent idleness, final flush, handle disposal, and Activation
removal before permit release. The descendant permit releases before its parent
owner can be woken by ownership removal.

If canonical cleanup fails, no quiescent release is attempted. If permit release
itself fails, the official disposal transaction fails and the policy continues
to report the lease as held.

## 7. Official call-site matrix

| Operation | Acquire boundary | Bind boundary | Release boundary |
| --- | --- | --- | --- |
| new one-shot | after provider/capability/schema/descriptor validation; before `provider.start()` | after provider publication; before caller success | after memoized `run.dispose()` proves quiescence |
| new continuable | after stable child id, descriptor, and provider capability validation; before `prepareContinuable()` | after Activation publication; before caller success or child work | startup rollback or canonical Activation disposal |
| cold resume | after persisted lineage, direct-parent authority, and descriptor validation; before Agent resume | after Activation publication | startup rollback or canonical Activation disposal |
| resident follow-up | no acquisition | no rebinding | reuse the resident Activation permit |
| descendant teardown | no acquisition | none | child-first before ancestor ownership wake |

`subagent/start`, `subagent/end`, and `registerContinuableSetup()` retain their
existing roles and never become enforcement authority.

### 7.1 Cancellation ordering

For every acquisition path, the runtime must:

1. check the caller signal before acquisition;
2. pass that signal to the policy;
3. recheck after acquisition settles;
4. release an acquired but untransferred permit with `startup-failed` when
   cancellation wins;
5. rollback a published child before release; and
6. stop treating the caller signal as permit authority after ownership transfers
   to a run or Activation.

This prevents caller cancellation from refunding capacity while child work is
still live.

## 8. Slim implementation strategy

The candidate continues to modify only:

| File | Responsibility |
| --- | --- |
| `src/types.ts` | detached protocol types |
| `src/index.ts` | registration state, acquisition helper, one-shot ownership |
| `src/continuation.ts` | fresh/cold acquisition, Activation bind, rollback and release |

The implementation should:

1. replace the frozen tombstone policy implementation with one tri-state slot;
2. remove release variants the official runtime cannot emit;
3. converge startup failure paths on one cleanup-then-release helper per owning
   module;
4. preserve a true no-policy fast path that returns the original one-shot run;
5. pass one optional permit through `MaterializeInputs` and `Activation` so fresh
   and cold paths share binding and disposal;
6. reuse the existing memoized run and Activation disposal transactions rather
   than add another lifecycle machine; and
7. retain failure aggregation and comments that explain non-obvious ownership
   ordering.

It must not move admission to an observe-only event, catch and discard rollback
failure, release before handle cleanup, or obtain its size reduction primarily
by deleting tests or lifecycle rationale.

## 9. Slim qualification gates

### 9.1 Size gates

| Metric | Reference | Slim requirement |
| --- | ---: | ---: |
| official files | 3 | no more than 3 |
| total changed lines | 418 | no more than 313 |
| `continuation.ts` changed lines | 187 | no more than 140 |
| serialized patch lines | 607 | report and target no more than 455; secondary only |

Changed lines are insertions plus deletions. Serialized patch length is secondary
because context lines and hunk layout can vary without changing code size.

### 9.2 Semantic gates

The candidate must retain:

- one explicit protocol version and one registration;
- stock no-policy behavior and one-shot object identity;
- one atomic authority across direct service callers and all adapters that use
  the service;
- provider and capability validation before charging invalid work;
- acquire-before-provider/materialization ordering;
- bind-after-publication ordering;
- cleanup-before-release ordering;
- lease retention on incomplete cleanup or failed release;
- resident-follow-up exclusion;
- cold-resume active admission without a new-child operation;
- descendant-first permit release; and
- permanent fail-closed behavior after policy removal.

The candidate is rejected if size passes but semantics fail. If semantics pass
but size misses, it may be described as a corrected reference candidate but not
as slim. Removing error handling, tests, or necessary invariant documentation to
pass the metric also rejects the candidate.

## 10. Patch migration and verification

The verified reference patch is not overwritten during development.

1. Keep `patches/dsh-subagent-admission-seam.patch` unchanged.
2. Create `patches/dsh-subagent-admission-seam-slim.patch` as a separate
   candidate.
3. Extend the verifier to select the reference or candidate explicitly.
4. Run the same upstream fixture against both.
5. Promote the candidate only after semantic, size, compatibility, and evidence
   gates pass.
6. Preserve the reference patch until promotion is separately reviewed.

Promotion requires a new SHA-256, an exact compatibility-target update, updated
documentation, and regenerated evidence. No fuzzy application to another
official commit is supported.

### 10.1 Required upstream conformance

All current fixture behaviors remain:

1. explicit protocol and permanent tombstone;
2. unsupported protocol rejection;
3. acquire before provider startup;
4. publication binding;
5. release only after one-shot quiescence;
6. provider rejection cleanup before release;
7. cleanup failure retains capacity;
8. binding failure cleans a published run before release;
9. binding rollback failure retains capacity;
10. outstanding permits remain releasable after tombstone;
11. no-policy path returns the original provider run;
12. fresh and cold acquire while resident follow-up does not;
13. provider preparation failure releases startup admission;
14. descendant-first permit release; and
15. cold-resume rollback release.

The slim protocol adds cancellation coverage:

16. policy receives the caller's exact signal;
17. cancellation after acquisition but before provider invocation performs a
    startup-failed release and starts no provider; and
18. post-publication cancellation follows official rollback/disposal and never
    refunds directly from the caller signal.

Verification order is:

```text
git apply --check
-> stock RED: protocol surface absent
-> apply slim candidate
-> build official subagent package
-> run complete official subagent tests
-> run reusable admission fixture GREEN
-> run external plugin typecheck, unit, and conformance tests
-> run packed Strict regression
-> measure patch and calculate SHA-256
```

The verification uses no model or external API. GUI rendering, HTTP success,
package installation, and local tests remain distinct evidence layers.

## 11. Official-facing design package

### 11.1 Agent Note

The proposed Agent Note follows official structure:

1. `Status: proposed`;
2. Problem;
3. Alternatives considered;
4. Decision;
5. Protocol and lifecycle boundaries;
6. Testing;
7. Consequences and deferred work.

It discusses the shared admission gap, why existing public hooks cannot provide
this authority, the three ownership edges, single-policy and tombstone
rationale, one-shot/continuable/cold-resume behavior, and zero-patch product
gate. It excludes GUI, hiring, product marketing, external default quotas, and
the full policy implementation.

### 11.2 Discussion #131 draft

Publication update: the final evidence-tightened source is tracked in
`docs/discussion-131-draft.md` and was separately authorized and published at
https://github.com/deepseek-ai/deepseek-harness/discussions/131#discussioncomment-18020293.
This section preserves the original pre-publication design gate; it does not
authorize follow-up comments.

The eventual comment is evidence-first, approximately 150--180 English words,
and asks one question:

> I built an independent lifecycle-admission experiment against DeepSeek
> Harness commit `47f9438` for the recursive subagent failure shape discussed
> here. In a bounded, no-model 56-child reproduction, Audit allowed all 56
> provider starts while the Strict reference policy admitted 4 for one root,
> denied 5 reachable excess branches before provider execution, and suppressed
> their 47 descendants.
>
> This is complementary to `dsh-turn-budget`, which already provides an
> immediately installable per-turn circuit breaker through public hooks. The
> remaining experiment is narrower: one atomic decision shared by direct
> `ctx.subagents` callers, tools, plugins and providers, with capacity retained
> through the official child lifecycle.
>
> The proposed official surface contains no limits, ledger, root resolver,
> telemetry or UI--only a versioned policy registration whose permit is acquired
> before provider/materialisation, bound after publication, and released after
> canonical quiescence. The repository includes a pinned patch and RED/GREEN
> lifecycle fixture.
>
> **Would this optional lifecycle-owned admission registration on
> `ctx.subagents` fit as a documented extension point?**

The comment must identify the project as independent and experimental,
acknowledge the closest plugin precedent, link exact evidence, avoid a patch
dump, ask for neither a merge nor a job, tag no maintainer group, and never bump
without new evidence.

Drafting this text does not authorize posting it. Discussion publication,
repository push, tag, GitHub Release, npm publication, LinkedIn communication,
and job application remain separate external actions.

## 12. Deliverable acceptance

The official-facing design package is complete when it contains:

- the proposed Agent Note;
- exact protocol and call-site matrix;
- alternatives and consequences;
- slim qualification results; and
- the concise Discussion draft with evidence links.

The executable slim deliverable is complete only when:

- its separate patch applies to the exact target;
- stock RED and patched GREEN are reproduced;
- complete official tests and external regressions pass;
- cancellation, rollback, cold resume, resident follow-up, and descendant-first
  cases pass;
- size gates pass without semantic deletion;
- compatibility identity and SHA-256 are updated; and
- the old reference remains recoverable until promotion review.

If zero-patch Strict cannot become a documented DSH extension point, the
repository remains a reference implementation and conformance system rather
than a sustainable patched-upstream product.
