# dsh-subagent-admission Design

- **Status:** Approved design; implementation has not started
- **Date:** 2026-08-13
- **Project:** `dsh-subagent-admission`
- **Positioning:** 80% admission kernel and evidence, 20% native DSH client surface

## 1. Executive decision

Build `dsh-subagent-admission` as an external, installable DeepSeek Harness
plugin that protects one DSH host process from unbounded subagent breadth and
concurrency. The product is a lifecycle-safe admission authority, not another
agent orchestrator, scheduler, or process-isolation layer.

The plugin has two honest compatibility modes:

- **Strict** enforces limits only when the official
  `@deepseek-ai/dsh-subagent` runtime exposes one small, versioned admission
  seam.
- **Audit** runs on stock DSH and reports observed activity, but never claims to
  enforce capacity.

The repository also carries a minimal reference patch for the official package.
There will be no private DSH fork, monkey patch, or partial-enforcement fallback.
The public plugin is the product; the upstream patch is a narrowly scoped seam
proposal and conformance fixture.

The v0.1 admission policy is fail-fast and queue-free. It covers one-shot and
continuable subagents across spawn, fork, foreground, background, ordinary
forked ancestry, and cold resume. Its defaults are:

| Limit | Default | Meaning |
| --- | ---: | --- |
| Global active | 6 | Maximum live subagent activations in this DSH process |
| Per-root active | 4 | Maximum live activations owned by one root conversation |
| Per-root admitted total | 24 | Maximum new child admissions for one root after coverage begins |
| Per-parent admitted children | 8 | Maximum new direct children admitted from one parent after coverage begins |

Capacity denial happens before provider work, child materialization, session
artifact creation, or a durable ledger write. An accepted new child consumes its
cumulative quotas permanently, even if provider startup later fails. Active
capacity is released only after canonical quiescent cleanup.

## 2. Evidence basis and strategic fit

### 2.1 Concrete demand

The immediate demand anchor is DeepSeek Harness
[Discussion #131](https://github.com/deepseek-ai/deepseek-harness/discussions/131),
which reports that nested, breadth-unbounded subagents can make the web service
unresponsive. The report describes roughly 56 spawn/fork continuable background
subagents, about 2.2 GB of memory, a saturated core, heavy session-file writes,
and recurrence after restart and continue.

This is a concrete user report in the official repository, not a
maintainer-approved roadmap item. At the design freeze, the discussion remained
open and unanswered by maintainers, with five upvotes and two community
comments. The distinction matters: this project can claim to address a
reproduced official-channel demand only after it reproduces the failure; it
cannot claim official endorsement.

The report suggests broad concurrency and total-count limits. This design goes
further by specifying:

- global, root, and direct-parent bounds;
- stable root ownership through ordinary forks;
- equal treatment of foreground and background work;
- separate semantics for new children, cold resume, and resident follow-up;
- admission before provider or materialization work;
- release at quiescent lifecycle ownership boundaries;
- durable cumulative quotas across process restart;
- fail-fast behavior with typed, deterministic errors;
- explicit single-process and no-process-isolation limitations.

### 2.2 Official contribution boundary

The official
[CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
currently says that external pull requests are not accepted, directs bugs and
feature requests to GitHub Discussions, and encourages external plugins under
the `dsh-plugin` topic.

Therefore the project must deliver value without an upstream merge. Strict mode
will demonstrate the value of a tiny seam, while Audit mode and the published
evidence remain usable against stock DSH. Official attention is pursued through
one evidence-rich reply to the existing demand, not through a duplicate launch
thread or a request for employment inside a technical discussion.

### 2.3 Design-time compatibility baseline

This table is an audit baseline, not a floating compatibility claim:

| Surface | Observed on 2026-08-13 |
| --- | --- |
| Official repository HEAD | `47f943859bef60e4160492346772ded9b24f765a` |
| `@deepseek-ai/dsh` npm `latest` / `next` | `0.1.0-rc.6` / `0.1.0-rc.6` |
| `@deepseek-ai/dsh-subagent` npm `latest` / `next` | `0.0.1-rc.1` / `0.1.0-rc.6` |
| Source package version observed in the audited checkout | `0.1.0-rc.5` family |

The source/npm mismatch is itself a release risk. Before implementation starts,
before every compatibility claim, and immediately before release, the project
must resolve and record the exact official commit, packed package versions, and
installed dependency graph. CI must pin those identities and separately monitor
master drift. “Works on master” is never inferred from an older checkout.

## 3. Goals and non-goals

### 3.1 Goals

1. Prevent one DSH process from accepting unbounded new subagent breadth or too
   many simultaneous subagent activations.
2. Make admission semantics consistent across one-shot, continuable, spawn,
   fork, foreground, background, and cold-resume paths.
3. Preserve root ownership across nested and ordinarily forked conversations.
4. Linearize accepted new-child accounting before provider work and child
   materialization.
5. Keep cumulative root and parent quotas durable across process restart.
6. Hold active capacity for the real lifecycle, including descendant cleanup.
7. Fail closed when Strict mode cannot prove coverage.
8. Provide typed denials, deterministic state snapshots, conformance evidence,
   crash fixtures, and reproducible performance measurements.
9. Expose a small, read-only native DSH client surface that makes enforcement
   state and quota ownership inspectable.
10. Demonstrate a minimal official seam without requiring users to run a private
    fork.

### 3.2 Non-goals

v0.1 does not provide:

- a capacity wait queue, priorities, fairness, or pre-emption;
- force-kill, force-release, counter reset, or GUI quota editing;
- multi-process, multi-host, or distributed admission correctness;
- operating-system process isolation or resource sandboxing;
- lifecycle accounting for remote compute that can survive the owning DSH host
  process;
- provider-rate-limit scheduling, token budgeting, or cost budgeting;
- generic DAG orchestration, workflow planning, or task routing;
- historical counting before the plugin's declared coverage start;
- proof of deployment, adoption, official endorsement, or hiring outcome;
- automatic npm publication or automatic posting to external channels.

## 4. Alternatives considered

### 4.1 External plugin plus a versioned reference seam — selected

Ship the complete policy, storage, telemetry, RPC, GUI, tests, and release
evidence externally. Add one optional, versioned registration point to the
official subagent runtime in a reviewable reference patch.

This keeps the plugin independently useful, minimizes upstream surface area,
and turns the official request into a precise lifecycle-boundary question. Its
cost is that stock DSH can only run Audit mode until an equivalent seam exists.

### 4.2 Private DSH fork — rejected

A fork could enforce immediately and modify every path, but it would quickly
drift from a developer-preview project, make installation and review harder,
and obscure whether the proposed boundary is generally useful. It would also
conflict with the goal of contributing infrastructure rather than maintaining a
parallel product.

### 4.3 Stock-only monkey patch or event listener — rejected

Wrapping providers, tools, or lifecycle events externally cannot prove that all
direct service calls are covered, and most events arrive after work has already
been materialized. Such an implementation would look functional while allowing
bypass paths and early release. It is acceptable only as clearly labelled
observation in Audit mode, never as Strict enforcement.

### 4.4 Audit-only observability product — rejected as the primary product

Audit-only is easy to install but does not stop the failure in #131. It remains
a compatibility mode and diagnostic tool, not the central claim.

## 5. Domain model and invariants

### 5.1 Terms

- A **root** is the durable top-level conversation that owns a complete nested
  subagent lineage. Ordinary conversation forks retain the original root for
  admission accounting.
- A **parent** is the direct durable session whose operation creates a new
  child.
- A **new child admission** creates a new one-shot or continuable child identity.
- An **activation** is one process-local DSH-owned residency epoch (`SubagentRun`
  ownership for one-shot or `Activation` ownership for continuable work) that can
  consume event-loop, memory, tool, provider, and descendant-lifecycle capacity.
  It does not claim ownership of remote compute after the DSH process dies.
- A **cold resume** reconstructs a previously created continuable child that has
  no resident activation.
- A **resident follow-up** sends another message to an already resident
  continuable child.
- **Coverage start** is the recorded point at which a root first becomes governed
  by this plugin. Historical admissions before this point are not represented as
  plugin-enforced totals.
- A **permit** is the unique ownership token returned by successful admission.

### 5.2 Hard invariants

For all reachable Strict-mode states:

1. `globalActive <= globalActiveLimit`.
2. For every root, `rootActive <= perRootActiveLimit`.
3. For every governed root, `admittedTotal <= perRootAdmittedTotalLimit`.
4. For every governed parent, `admittedChildren <= perParentChildrenLimit`.
5. Every process-local active activation owns exactly one unreleased permit.
6. A permit belongs to exactly one root and at most one child activation.
7. A new admission increments root total and parent child total exactly once.
8. Cumulative increments are never refunded after successful admission.
9. Active counts are released exactly once and only after quiescent cleanup.
10. A resident follow-up creates no permit and changes no quota.
11. A cold resume creates one active permit but changes no cumulative quota.
12. No provider call, materialization, child session artifact, or model request
    occurs before successful admission.
13. A denied operation changes no authoritative state.
14. Root binding is immutable for the process lifetime and must agree with the
    durable parent chain.
15. Missing, cyclic, conflicting, or unprovable lineage cannot enter Strict
    enforcement.
16. Policy unload closes new admission before it begins draining, but every
    outstanding permit remains releasable.
17. Telemetry, GUI state, and admission history are never authoritative inputs
    to a capacity decision.

### 5.3 Configuration rules

The four limits are positive safe integers. The policy rejects invalid startup
configuration, including:

- `perRootActive > globalActive`;
- `perRootActive > perRootAdmittedTotal`;
- `perParentChildren > perRootAdmittedTotal`.

v0.1 reads limits from plugin configuration. The GUI cannot change them.
Changing configuration requires a normal plugin or host restart. Tightening a
limit below an existing cumulative count or current active count does not kill
work or rewrite history: existing work drains naturally and all incompatible new
admissions fail fast.

## 6. Admission semantics

### 6.1 Operation matrix

| Operation | Active checks | Root total | Parent children | Durable ledger transaction | New permit |
| --- | --- | --- | --- | --- | --- |
| New one-shot spawn/fork | Global + root | Check and increment | Check and increment | Exactly one | Yes |
| New continuable spawn/fork | Global + root | Check and increment | Check and increment | Exactly one | Yes |
| Cold resume of disposed continuable | Global + root | No change | No change | None | Yes |
| Resident continuable follow-up | Covered by existing activation | No change | No change | None | No |
| Release after quiescent cleanup | Decrement global + root | No change | No change | None | Releases existing permit |
| Denial | Check only | No change | No change | None | No |

Foreground and background flags do not alter this matrix. They describe caller
settlement behavior, not host resource ownership. A continuable activation that
is waiting for owned descendants remains active and retains its permit.

### 6.2 Canonical decision order

Validation that is unrelated to capacity runs first, so malformed requests do
not consume quotas. The order is:

1. request schema, provider existence, provider capability, cancellation, and
   normal DSH depth checks;
2. registered-policy protocol and lifecycle state;
3. durable parent lineage and bootstrap safety;
4. per-root admitted-total limit;
5. per-parent admitted-children limit;
6. per-root active limit;
7. global active limit;
8. atomic reservation.

When several capacity limits are exceeded, the first failure in this order is
returned. Permanent cumulative failures precede transient active failures, which
makes diagnostics stable and tells an operator when retrying cannot help. There
is no wait-for-capacity path.

### 6.3 Typed failures

The public error vocabulary is stable even if implementation classes change:

| Code | Meaning |
| --- | --- |
| `ADMISSION_UNAVAILABLE` | Required seam, protocol, storage, or safe bootstrap is unavailable |
| `ADMISSION_CLOSED` | Policy is unloading or closed to new permits |
| `ADMISSION_STATE_IO` | Authoritative ledger transaction could not be completed |
| `ADMISSION_BINDING_CONFLICT` | A child/root binding conflicts with durable lineage |
| `ROOT_TOTAL_LIMIT` | Root has exhausted its post-coverage new-child total |
| `PARENT_CHILD_LIMIT` | Parent has exhausted its post-coverage direct-child total |
| `ROOT_ACTIVE_LIMIT` | Root already owns the maximum live activations |
| `GLOBAL_ACTIVE_LIMIT` | Host process already owns the maximum live activations |

A denial includes only detached operational metadata needed for diagnosis:
operation, mode, root ID, parent ID, observed value, limit, policy epoch, and
request correlation ID. It never includes prompts, messages, tool arguments,
model output, secrets, or provider credentials.

### 6.4 Linearization and cleanup

The lifecycle for a new child is:

```text
normal DSH validation
  -> durable root resolution
  -> serialized atomic check, reservation, and lease insertion
     (linearization point)
  -> permit returned
  -> provider preparation / provider start
  -> child materialization and publication
  -> permit-child binding
  -> execution
  -> canonical quiescent cleanup
  -> permit release
```

For a new child, the admission linearization point is the atomic ledger commit
plus non-throwing in-memory lease insertion inside the same serialized critical
section. Returning the permit is the caller-visible confirmation of that
decision. If the process dies after the durable commit but before the caller
observes the permit, the outcome is conservatively charged on restart; the
caller cannot assume that a lost response means no admission. For a cold resume,
the linearization point is insertion of the process-local active lease.

Cancellation before linearization consumes nothing. Cancellation or provider
failure after linearization keeps the cumulative new-child admission charged,
because the host already accepted the attempt; this prevents retry storms from
bypassing a total bound. The active lease remains held until partial resources
have been cleaned and then releases exactly once. Permit construction and lease
insertion are deliberately non-I/O, non-user-code operations; an unexpected
post-commit invariant failure fail-stops Strict admission instead of continuing
with uncertain state.

The plugin serializes only the short authoritative check/reserve critical
section. This internal transaction chain is not a capacity queue: a request may
briefly wait for an in-flight state mutation to finish, but it never waits for
another activation to release capacity.

## 7. Minimal official admission seam

### 7.1 Registration contract

`SubagentRuntime` gains one optional admission authority registered through:

```ts
registerAdmissionPolicy(policy)
```

The exact public type is defined by the reference patch, but the behavioral
contract is fixed:

- only one policy can be registered at a time;
- duplicate registration fails loudly;
- the registered object must declare `protocolVersion: 1` and satisfy the exact
  versioned schema; no method-presence duck typing selects a protocol;
- registration is optional, so stock behavior remains unchanged when no policy
  is present;
- the request contains plain, detached metadata and no borrowed `Agent`,
  `AgentHandle`, provider object, prompt, result, or disposal authority;
- the request supplies the durable parent identity and operation metadata but no
  trusted root identity; the external policy resolves the root from durable
  ancestry;
- normal provider-capability validation is separate from provider preparation
  and completes before policy admission;
- successful policy preparation returns a permit with child binding and release
  operations;
- binding is at most once, release is idempotent, and conflicting repeats fail
  loudly;
- unregistering first tombstones the authority, synchronously rejecting new
  admission, then allows outstanding permits to drain and release.

The seam is an ownership boundary, not a configuration API. The external plugin
owns limits, durable accounting, telemetry, and GUI state.

### 7.2 Required hook points

The seam must be reached from centralized service/runtime paths, not only from
tools or built-in providers:

1. **One-shot start:** after provider/capability/request validation and before
   `provider.start()`.
2. **Continuable creation:** after the stable child ID is reserved and all pure
   validation completes, but before `prepareContinuable()` and materialization.
3. **Cold resume:** after durable descriptor/parent validation and before a new
   Activation materializes.
4. **One-shot release:** wrap `SubagentRun.dispose()` and release only after the
   wrapped disposal reaches quiescence, including failed startup cleanup.
5. **Continuable release:** release at the end of the continuation manager's
   canonical `finishDisposal()` transaction, after child-first cleanup and
   ownership removal.

A resident follow-up uses the existing Activation and does not call admission.
All foreground/background, spawn/fork, built-in-provider, and direct
`ctx.subagents` callers converge on these points.

### 7.3 Permit lifecycle

A new permit initially owns a root and parent admission. Once a provider
publishes a child identity, `bindChild` associates that identity with the same
root and verifies any local child's durable `parentSession` metadata. A cold
resume permit is bound to the already known child identity at preparation.

The official runtime, not the external policy, controls when provider and agent
objects are created or disposed. The policy receives only lifecycle edges and
detached identities. This keeps the seam small and prevents the plugin from
becoming a second subagent runtime.

## 8. External plugin architecture

### 8.1 Package and installation boundary

`dsh-subagent-admission` is an installable package with a valid
`dsh.bundle.patch`. Installing it as a plain dependency without the DSH bundle
patch is explicitly reported as inactive.

Host-side responsibilities:

- mode selection and compatibility detection;
- admission policy registration;
- root resolution and bootstrap checks;
- authoritative cumulative ledger;
- process-local active leases;
- best-effort telemetry and bounded history;
- read-only snapshot RPC.

Client-side responsibilities:

- render the Admission Control conversation surface;
- long-poll full snapshots;
- distinguish Strict, Audit, Unavailable, and Draining states;
- expose no mutation or lifecycle-control action.

### 8.2 Component boundaries

| Component | Responsibility | Dependencies |
| --- | --- | --- |
| Compatibility Probe | Resolve DSH versions, seam protocol, install activation, and supported mode | Package metadata and registered host services |
| Admission Authority | Apply canonical checks, serialize reservations, mint/release permits | Root Resolver, Ledger, Active Lease Registry |
| Root Resolver | Resolve stable root via all-parent durable traversal | DSH session persistence and immutable binding cache |
| Root Admission Ledger | Persist post-coverage root totals and per-parent totals | Host-supported JSON/SQLite storage adapter |
| Active Lease Registry | Track global/root process-local activations | Admission permits and lifecycle release edges |
| Telemetry Projector | Produce bounded, non-authoritative events and snapshots | Authority events only |
| Snapshot RPC | Serve `snapshot.get` and `snapshot.watch` | Telemetry Projector |
| Admission Control View | Render status, quotas, leases, and history | Snapshot RPC only |

Each component has one direction of authority: the GUI cannot mutate telemetry;
telemetry cannot mutate admission; providers cannot mutate the ledger; and
storage does not infer lifecycle state.

## 9. Root ownership and state

### 9.1 Durable all-parent traversal

Root identity is resolved by the plugin from the complete durable `parentSession`
chain, not supplied as a trusted field by a child or guessed from the current UI
tree. Ordinary conversation forks remain in the same root domain. Resolution
must detect missing parents, cycles, and conflicting cached bindings.

`SessionRootBinding` is a process-local immutable memoization table. Its source
of truth is the durable DSH parent chain, so it can be reconstructed after
restart and does not require a second plugin write for each admitted child.
`bindChild` adds a cache entry only after verifying the published child identity
against that chain. Once present, a different root for the same session is a
binding conflict, not a cache refresh.

This distinction resolves the operation budget: an accepted new child performs
exactly one plugin-authoritative durable transaction in the root ledger.
Ordinary DSH session persistence is part of child materialization, not an
admission-ledger transaction. `bindChild` updates the immutable in-memory cache
and performs no plugin durable write.

### 9.2 Durable ledger

There is one logical `RootAdmissionLedger` per governed root, containing:

- root session ID;
- coverage-start identity and timestamp;
- total accepted new-child admissions since coverage start;
- accepted direct-child admissions keyed by parent session ID;
- monotonically increasing ledger revision;
- storage schema version.

JSON and SQLite adapters must expose the same single-transaction behavior. A new
admission checks both cumulative limits and increments both counters in one
atomic durable update. A write failure returns `ADMISSION_STATE_IO`, allocates no
active lease, and calls no provider.

The ledger records accepted admissions, not only successfully materialized
children. A crash immediately after the ledger commit therefore consumes
cumulative quota but cannot exceed it on restart.

### 9.3 Process-local active leases

Active leases are deliberately not durable. A DSH process crash terminates the
DSH-owned run/Activation objects whose host capacity they represent; the next
process starts with zero active leases while retaining cumulative ledger state.
Any external compute that can outlive those host-owned objects is outside the
v0.1 active-capacity guarantee and cannot be represented as Strict coverage.

This assumption defines the deployment boundary. v0.1 supports one DSH host
process owning a session store. Strict startup must acquire an exclusive
process-ownership guard scoped to that store and hold it until policy teardown;
failure to acquire or maintain the guard makes Strict Unavailable. The concrete
cross-platform locking mechanism is selected in the implementation plan, but it
must fail closed and survive stale-process cleanup without allowing two live
owners. If multiple processes can concurrently create or resume subagents for
the same logical deployment, a process-local global-active limit is not globally
safe. Audit mode may still observe the local process and must label that
limitation.

### 9.4 Coverage bootstrap

Coverage begins when the plugin establishes a root ledger. It does not claim to
count children admitted before installation.

Strict activation requires a bootstrap scan sufficient to prove that:

- every currently relevant session has a complete, acyclic durable parent chain;
- there is no conflicting root binding;
- no already-live subagent activation can run outside the new authority;
- the deployment is single-process for this session store.

Historical inactive children may remain outside cumulative totals. Resuming one
still requires a cold-resume active permit, so an old nested tree cannot all
reactivate at once. If active ownership or ancestry cannot be proved, Strict is
Unavailable rather than partially enabled; Audit remains available with the
reason exposed.

## 10. Failure and lifecycle behavior

| Failure point | Required behavior |
| --- | --- |
| Request/provider validation | Reject normally; no admission state touched |
| Capacity check | Typed fail-fast denial; zero writes/provider/materialization |
| Ledger transaction | Fail closed with `ADMISSION_STATE_IO`; no permit/provider call |
| Cancellation before linearization | No quota consumed |
| Cancellation after linearization | Cumulative quota retained; active lease released after cleanup |
| Provider preparation/start | Cumulative quota retained; clean partial resources; release active once |
| Child binding mismatch | Fail closed, clean child, retain cumulative charge, release active after cleanup |
| One-shot result settles before disposal | Permit remains held until `dispose()` quiesces |
| Continuable waits on descendants | Permit remains held until child-first `finishDisposal()` completes |
| Cold-resume materialization fails | No cumulative change; release resume permit after cleanup |
| Duplicate release | Idempotent no-op with diagnostic telemetry, never a negative counter |
| Duplicate policy registration | Fail loudly; existing authority remains unchanged |
| Policy unload | Tombstone new admission, drain permits, keep release path alive |
| Process crash after ledger commit | Durable total retained; process-local active leases vanish with process |
| Unknown seam/protocol | Strict Unavailable; no partial enforcement; Audit only if its probes remain valid |

There is no administrative force-release in v0.1. A permit that remains held
because canonical cleanup has not finished is evidence of real or leaked
ownership and must be visible in telemetry, not erased to improve the dashboard.

## 11. Native Admission Control view

### 11.1 Product surface

The GUI is a native DSH client contribution named `conversation.view`. It is not
a separate desktop application, generic settings page, tree replacement, or
floating HUD.

For the selected conversation/root it shows:

1. **Policy status** — Strict, Audit, Unavailable, or Draining, including exact
   compatibility and bootstrap reason.
2. **Quota cards** — global active, root active, root admitted total, and selected
   parent admitted children, each with usage and configured limit.
3. **Active leases** — child ID, parent ID, root ID, operation/mode, admission
   timestamp, and lifecycle phase.
4. **Admission history** — accepted, denied, released, failed-start, protocol,
   and bootstrap events in a bounded recent window.

The view exposes no kill, reset, retry, release, edit, or quota slider. Text,
icons, and accessible labels must communicate state without relying on color.

### 11.2 Snapshot protocol

The host exposes two read-only RPC methods:

- `snapshot.get(scope)` returns the current full snapshot.
- `snapshot.watch({ scope, epoch, revision, timeout })` long-polls until state
  changes or the timeout expires, then returns a full snapshot.

Snapshots are full replacements, not deltas. Every snapshot carries:

- process epoch;
- monotonically increasing in-epoch revision;
- generation timestamp;
- mode, compatibility, and availability reason;
- configured limits and current usage;
- active leases;
- bounded admission history.

A process restart changes the epoch. A client that misses revisions simply
replaces its local state with the latest full snapshot. Snapshot reads do not
call a provider or write the authoritative ledger.

Admission history is a process-local, best-effort ring of the most recent 200
events. It resets with the process epoch, is never replayed into authoritative
state, and drops the oldest event on overflow. A dropped-history count in the
snapshot makes truncation visible.

### 11.3 Privacy boundary

RPC payloads and GUI state must never contain prompt content, conversation
messages, model output, tool arguments, environment values, credentials, or raw
error stacks that may embed them. Session IDs and coarse operational metadata
are included only because they are necessary to explain ownership. Privacy tests
must assert both allowed fields and forbidden-field absence.

## 12. Compatibility truth table

| Environment | Mode | Claim |
| --- | --- | --- |
| Exact supported DSH with protocol-v1 seam | Strict | All conformance paths enforced |
| Stock DSH without seam | Audit | Observation only; no enforcement claim |
| DSH with unknown protocol version | Unavailable for Strict | No registration or partial enforcement |
| DSH version outside tested matrix but with observable stock events | Audit, labelled unverified | Local observation only |
| Multiple DSH processes sharing ownership | Unavailable for Strict | Local active state cannot prove global safety |
| Unsafe or conflicting lineage bootstrap | Unavailable for Strict | Audit exposes the reason |
| Plugin package installed without active `dsh.bundle.patch` | Inactive/Unavailable | No claim that the plugin is loaded |

Compatibility is a runtime status, a README matrix, and a CI artifact. It is not
inferred from package semver alone. Unknown combinations fail closed for Strict.

## 13. Verification design

### 13.1 Deterministic state model

A pure reference model consumes operations such as new one-shot, new
continuable, cold resume, resident follow-up, provider failure, cancellation,
bind, disposal, unload, and restart. Generated sequences compare the model with
the implementation after every transition.

Required properties include all invariants in Section 5 plus:

- counters never become negative;
- the same operation sequence produces the same typed denial order;
- a restart preserves cumulative totals but resets active leases;
- a failed ledger transaction changes neither durable nor active state;
- admission IDs, permits, bindings, and releases remain exactly-once under
  duplicate callbacks and cancellation races.

### 13.2 Direct-service conformance matrix

Tests must call the central service/runtime APIs directly, not only public tools.
The matrix covers:

- spawn and fork providers;
- one-shot and continuable children;
- foreground and background caller behavior;
- nested children and ordinary parent forks;
- cold resume and resident follow-up;
- cancellation before and after admission;
- provider preparation failure, provider start failure, materialization failure,
  and disposal failure/retry;
- policy unload while permits are active;
- missing seam, wrong protocol, duplicate policy, and unsafe bootstrap.

Every tool-level path gets a smaller integration test proving that it converges
on the same runtime seam. A built-in provider, a fake provider, and direct
`ctx.subagents` calls must not bypass enforcement.

### 13.3 Lifecycle fixtures

Fake Provider, Agent, AgentHandle, Activation, and persistence components expose
barriers at each lifecycle boundary. Tests explicitly prove:

- no child artifact exists before admission;
- a one-shot permit survives result settlement until `dispose()` completes;
- a continuable permit survives idle/waiting state and owned descendants;
- `finishDisposal()` releases only after child-first cleanup;
- a cold-resume race cannot overlap two activations for one child;
- canonical cleanup runs before active release after every startup failure.

### 13.4 Crash and storage fixtures

The suite terminates a fixture process immediately after the root ledger commit
and before provider/materialization work. On restart, both JSON and SQLite
adapters must retain the cumulative charge, expose no stale active lease, and
deny the next operation if the retained charge reached a limit.

Additional restart fixtures cover:

- clean shutdown with active-drain completion;
- corrupt or unsupported ledger schema;
- missing/cyclic durable ancestry;
- old pre-coverage continuable sessions cold-resuming under active limits;
- snapshot epoch changes.

### 13.5 Operation budgets

Instrumented tests enforce these budgets:

| Path | Provider calls | Child materializations | Plugin ledger transactions |
| --- | ---: | ---: | ---: |
| Capacity denial | 0 | 0 | 0 |
| Accepted new child | As required after admission | At most 1 | Exactly 1 |
| Cold resume | As required after admission | At most 1 | 0 |
| Resident follow-up | Existing activation only | 0 | 0 |
| Release | 0 new calls | 0 new materializations | 0 |
| Snapshot get/watch | 0 | 0 | 0 |

These counts distinguish the plugin's authoritative ledger transaction from
normal DSH child-session persistence. The test harness reports both separately
so the distinction cannot hide accidental extra policy writes.

### 13.6 Performance evidence

The first release does not invent an absolute p95 target before measuring the
host and storage baselines. It publishes reproducible commands, machine/runtime
metadata, raw samples, and a reference report for:

- denied admission latency;
- accepted new admission transaction latency;
- cold-resume admission latency;
- release latency after the official cleanup boundary;
- snapshot get/watch overhead;
- sustained concurrent check/reserve races;
- the bounded-vs-unbounded #131 reproduction workload, when safely reproduced.

Release evidence reports distributions and overhead relative to a pinned stock
baseline. A later hard regression budget may be adopted only from repeatable
data.

### 13.7 CI and drift monitoring

Required release checks are:

- build and lint;
- unit and deterministic model tests;
- direct-service and tool integration tests;
- JSON and SQLite crash/restart fixtures;
- native GUI component and RPC privacy tests;
- packed-plugin installation with `dsh.bundle.patch` activation proof;
- Linux full suite on Node 22.19 and Node 24;
- macOS and Windows smoke coverage;
- exact supported DSH package matrix;
- separate official-master drift job that may fail informatively without
  rewriting the supported matrix.

An exact supported package failure blocks release. A master drift failure marks
future compatibility work and cannot be presented as a failure of a previously
pinned release.

## 14. Repository and release design

### 14.1 Public identity

- Repository/package name: `dsh-subagent-admission`
- Tagline: `Lifecycle-safe admission control for DSH subagents.`
- GitHub description: `Lifecycle-safe subagent admission control for DeepSeek
  Harness: bounded concurrency and breadth across spawn, fork, and continuable
  agents.`
- First release: `v0.1.0-rc.1`
- First distribution route: GitHub packed install
- npm publication: deferred until package ownership, authentication, packed
  install, and explicit publication authorization are verified

Recommended repository topics:

`dsh-plugin`, `deepseek-harness`, `agent-infrastructure`, `admission-control`,
`subagents`, `reliability`, and `cordis`.

### 14.2 Required release artifacts

The release candidate includes:

- `README.md` and `README.zh-CN.md`;
- installable host/client plugin package and `dsh.bundle.patch`;
- `docs/architecture.md`;
- `docs/compatibility.md`;
- `docs/upstream-seam.md`;
- `docs/reproduction.md`;
- the compact reference seam patch;
- machine-readable conformance results;
- raw benchmark results and reference report;
- `SECURITY.md`, `LICENSE`, and `CHANGELOG.md`.

The README begins with the mode truth banner: “Strict requires the versioned
seam; Audit works on stock DSH and does not enforce.” It then presents the #131
problem, exact guarantees and non-goals, one install command, compatibility and
coverage matrices, and links to raw evidence. GUI screenshots demonstrate the
inspection surface only; they are not kernel evidence. Badge walls and implied
official endorsement are excluded.

### 14.3 Publication gates

No public release candidate is created until:

1. the official HEAD/npm/#131 baseline is refreshed;
2. every pinned Strict conformance path passes;
3. stock Audit mode is verified to make no enforcement claim;
4. crash fixtures pass for JSON and SQLite;
5. packed installation proves the bundle patch is active;
6. privacy tests pass;
7. raw benchmark commands and environment metadata are reproducible;
8. the compatibility matrix names exact tested identities and limitations.

Publishing, npm publication, profile mutation, Discussion posting, curated-list
pull requests, LinkedIn posting, and job applications are separate external
actions. Each requires authorization at the point of action.

## 15. Official-attention and hiring strategy

### 15.1 Selected route: evidence-first existing demand

The selected route is:

```text
refresh official baseline and freeze safe reproduction
  -> pass local correctness gates
  -> publish GitHub v0.1.0-rc.1 with evidence and dsh-plugin topic
  -> pin project and make the author contact route immediate
  -> reply once to Discussion #131 with evidence and one seam question
  -> enter curated lists after a stable release
  -> publish one technical LinkedIn explanation
  -> use a separate normal job application only for a verified matching role
```

A launch blitz across Show and Tell, Ideas, Discord, and LinkedIn is rejected as
noisy and likely to sink in a crowded launch-day ecosystem. A quiet repository
alone is professional but unlikely to reach maintainers. One strong artifact
attached to an existing concrete demand has the best signal-to-noise ratio.

### 15.2 Discussion reply contract

The reply to #131 is posted only after the evidence it cites exists. It contains:

1. the exact DSH version/SHA and safe reproduction result;
2. coverage across spawn/fork, one-shot/continuable, cold resume, resident
   follow-up, and ordinary fork lineage;
3. fail-fast semantics and exact configured/default limits;
4. links to conformance, crash, packed-install, and benchmark evidence;
5. explicit limitations: Strict requires the seam, stock is Audit-only, v0.1 is
   single-process and provides no process isolation;
6. one narrow upstream-boundary question.

The proposed question is:

> Would a single versioned admission-policy registration at the
> SubagentRuntime continuation-creation and cold-resume ownership boundaries fit
> the intended plugin boundary? If not, which pre-materialization lifecycle
> boundary should external capacity policies use?

The comment does not dump a patch, ask for a merge, request a job, tag a group of
maintainers, or interpret silence as rejection. A follow-up is posted only when
there is new evidence such as a new rc compatibility result, external
reproduction, benchmark, or official-master change. There are no “bump” posts.

### 15.3 Ecosystem distribution

The `dsh-plugin` topic is added at first release so automated ecosystem scanners
can find the repository. After stable release:

- allow
  [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)
  to discover it through its normal scan route;
- submit a factual English-and-Chinese Infrastructure & Development entry to
  [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)
  under that repository's contribution rules;
- make at most one Discord announcement that links to the repository and #131
  rather than creating a parallel support thread;
- publish one technical LinkedIn post explaining the failure, invariant,
  evidence, and limitations.

### 15.4 Personal reachability

The author's GitHub identity remains professional and technically focused. At
release time, subject to explicit authorization:

- pin `dsh-subagent-admission` first, followed by the strongest agent-infra and
  VULCA evidence repositories;
- use LinkedIn as the GitHub header Website so a human can contact the author
  without searching the profile README;
- retain the profile README's DeepSeek-relevant agent harness, evaluation, and
  evidence-governance positioning;
- optionally add “Open to agent infrastructure and research engineering
  opportunities.”

No personal email is published without separate approval. The technical
Discussion contains no hiring language. If a current matching DeepSeek role is
later verified, the application is a separate concise evidence note linking the
repository and official Discussion.

### 15.5 Evidence funnel

| Level | Required evidence | What does not qualify |
| --- | --- | --- |
| L0 Release | Public repo/tag, packed install, pinned CI and evidence artifacts | Local files or screenshots alone |
| L1 Discoverability | Topic indexing, curated-list entry, profile pin | A repository merely existing |
| L2 Official technical engagement | Maintainer reply, question, or request for material | Community upvotes or ordinary comments |
| L3 Independent adoption | External installation, reproduction, issue, or integration | Stars, views, or self-run demos |
| L4 Hiring | Direct human contact, interview, or formal process | Attention, praise, or a profile visit |

Reporting must keep publication, discoverability, official engagement, adoption,
and hiring outcomes separate.

## 16. Implementation decomposition

This design is narrow enough for one implementation plan but should be executed
as independently verifiable milestones:

1. refresh and pin the official compatibility baseline;
2. build the pure state model, typed errors, and invariant tests;
3. build root resolution, durable ledger adapters, and crash fixtures;
4. build the admission authority and lifecycle permit tests;
5. create and test the minimal official reference seam;
6. compose the external Strict/Audit host plugin;
7. add snapshot RPC and privacy tests;
8. add the read-only native Admission Control view;
9. add packed-install, cross-platform CI, compatibility, and benchmarks;
10. prepare release documentation and evidence without publishing;
11. request separate approval for public repository/release and each external
    communication action.

The subsequent implementation plan may choose concrete libraries and file
layout after inspecting the refreshed DSH package patterns, but it may not alter
the admission semantics, authority boundaries, compatibility claims, or release
evidence gates without returning to design review.

## 17. Acceptance criteria

The v0.1 release candidate is technically complete only when all of the following
are demonstrated against exact pinned identities:

- the four default quotas and configurable validation rules behave exactly as
  specified;
- all operation paths in the matrix converge on the central seam;
- capacity denial performs zero provider, materialization, and ledger-write work;
- every accepted new child performs exactly one authoritative ledger
  transaction;
- cumulative quota survives crashes and active capacity does not leak across a
  dead process;
- one-shot and continuable permits release only at their canonical quiescent
  boundaries;
- cold resume consumes active capacity and resident follow-up does not;
- ordinary forks resolve to a stable root;
- unsafe bootstrap, protocol mismatch, multi-process ownership, and missing seam
  cannot present as Strict;
- Audit mode never claims enforcement;
- GUI/RPC expose accurate full snapshots without sensitive content or mutation
  controls;
- JSON/SQLite restart, packed install, Node 22.19/24 Linux, and macOS/Windows
  smoke checks pass;
- benchmark and conformance raw evidence are reproducible;
- public claims state the single-process, no-queue, no-process-isolation, and
  post-coverage-total boundaries;
- no external publication or communication is inferred from local completion.

This is the frozen design contract for the implementation plan.
