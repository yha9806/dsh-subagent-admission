# DSH admission novelty and coverage gate

- Gate rerun: 2026-08-14T09:39:19Z (UTC)
- Decision: **Reframe v2 — Go, extremely narrow**
- Method: current primary sources only—exact official and competitor Git
  commits, official npm metadata, Discussion #131 HTML/API, and direct source
  inspection. Search absence is not proof of non-existence.

## 1. Official demand and runtime surface

### Exact official identity

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- HEAD: `47f943859bef60e4160492346772ded9b24f765a`
- Source `@deepseek-ai/dsh-subagent`: `0.1.0-rc.5`
- npm `@deepseek-ai/dsh` latest/next: `0.1.0-rc.6` / `0.1.0-rc.6`
- npm `@deepseek-ai/dsh-subagent` latest/next: `0.0.1-rc.1` /
  `0.1.0-rc.6`
- Baseline status: `source-npm-diverged`

`pnpm baseline:check` matched the live official source, npm, and Discussion
identities at the gate rerun.

### Relevant lifecycle points

At the exact source commit, all paths are under
`packages/subagent/subagent/src/`:

- `registerProvider(provider)` is an effect-scoped named-provider registry.
- `start(name, request)` validates provider/capabilities/depth/schema and then
  calls `provider.start(resolved)`; there is no external pre-materialisation
  capacity veto.
- `startContinuable(spec)` delegates to the continuation manager.
- `followup(...)` routes to a resident activation or cold-resumes a disposed
  continuable child from its persisted descriptor.
- `subagent/start` and `subagent/end` are emit-only observations published
  after lifecycle work exists; they cannot deny a start.
- stock depth checks bound recursion depth, not breadth, global/root active
  capacity, or cumulative child creation.

Conclusion: the exact official runtime still has no versioned, external,
pre-materialisation admission protocol and no shared capacity authority across
its callers.

### Discussion #131

- URL: `https://github.com/deepseek-ai/deepseek-harness/discussions/131`
- State: open
- Comments: 4 API rows
- Upvotes: 5 in the canonical HTML baseline
- `updated_at`: `2026-08-14T03:55:21Z`
- Comment author associations: all four `NONE`
- Maintainer-associated comments: 0

The report remains a concrete official-channel demand anchor, not a maintainer
roadmap commitment or endorsement. It describes 56 nested spawn/fork,
continuable, background children, high memory/CPU/session-write pressure, and
recurrence after restart/continue.

## 2. Close precedents

The `dsh-plugin` topic was highly active—1,582 repository search results at the
gate timestamp—so broad “first plugin” claims are not credible. Three current
projects are especially relevant.

### 2.1 `PerryLink/dsh-background-agents`

- Exact commit: `fdcca3dbd9ff35b618d10e2c686c3f4c79bf3313`
- Package: `dsh-background-agents@0.3.0`
- Product: durable interactive continuable background agents, restart recovery,
  messaging/stop/result tools, structured projection, and native Web panel.
- Default `maxBackgroundAgents = 4` per parent.

What it now correctly covers:

- the `background_agent` tool counts non-archived continuable direct children
  from `ctx.subagents.listChildren`, including children already created by the
  built-in subagent tool;
- a per-parent promise gate serialises that tool's
  `count -> cap check -> startContinuable` critical section;
- a focused test proves two concurrent calls through that same tool cannot both
  pass a cap of one;
- durable catalogue/projection recovery and real SubagentRuntime integration
  are tested;
- its GUI is useful and materially more mature than a limit-only panel.

This invalidates two earlier possible claims: it is a close DSH limiter
precedent, and its current own-tool count/check path is not racy.

Remaining boundary, from exact source:

- the promise-gate `Map` is local to `registerBackgroundAgentTools` and is
  acquired only inside `background_agent.execute`;
- an internal tool, another plugin, SDK caller, or direct
  `ctx.subagents.startContinuable` call does not acquire that gate;
- the plugin can count an already-created external continuable child on its
  next tool invocation, but cannot atomically prevent a simultaneous external
  start from exceeding its cap;
- it covers non-archived continuable direct children per parent, not one-shot,
  global/root active capacity, root/parent durable cumulative accounting, or a
  cold-resume permit held to quiescent cleanup;
- when the durable catalogue raises `SubagentError`, cap counting falls back to
  this plugin's live registry and permits progress, so it is intentionally not
  Host-wide fail-closed enforcement.

This is a product and architecture precedent to integrate with, not dismiss or
clone.

### 2.2 `NanmiCoder/dsh-agent-teams`

- Exact commit: `aace29c267b798a014be030768b85f5a2fc73818`
- Product: team creation, continuable members, task/dependency state,
  inter-member messaging, persisted team state, and activity GUI.
- Default `maxMembers = 8`, enforced while adding a member under the team's
  state lock; optional member max depth.

The member cap is a valid team-local product rule. It is not a shared Host
capacity authority across non-team tools/providers, one-shot work, roots, or
cold-resume lifecycle ownership.

### 2.3 `FEOH333/dsh-delegate`

- Exact commit: `30597c014b1c2bba8bd2d4a340ebc18949039c63`
- Product: per-call model selection, personas, `task_id`/`depends_on` ordering,
  durable run roster, audit events, and UI cards.
- Explicit dependency gates are authoritative for declared dependencies; most
  roster/tracking paths are documented as advisory and degrade rather than
  interrupt delegation.

Dependency ordering is not resource admission and provides no shared Host
active/cumulative capacity boundary.

## 3. Pi comparison

The audited Pi extension architecture uses process-per-child isolation and
bounded worker pools (parallel tasks capped at eight and concurrent workers at
four in the inspected example). Community Pi extensions also expose local
concurrency queues.

Pi proves that bounded parallelism and process isolation are established agent
infra patterns. It does not provide a drop-in DSH root/parent ledger, cold-
resume ownership, or official SubagentRuntime admission seam. This project
must not market basic concurrency limiting as novel.

## 4. Three required judgments

### Already covered

- DSH stock: provider registration, depth accounting, continuable lifecycle,
  persisted descriptors, post-publication events, and scoped teardown.
- Existing DSH plugins: per-tool/per-team limits, own-tool race serialisation,
  continuable catalogues, dependency gates, restart recovery, and mature GUIs.
- Pi and adjacent runtimes: bounded worker pools, queues, and process isolation.

### Still unsolved at the official DSH boundary

- one atomic admission decision shared by built-in tools, external plugins,
  providers, SDK/direct service callers, foreground/background paths, and
  one-shot/continuable operations;
- a pre-provider, pre-materialisation veto rather than post-start counting;
- separate global/root active capacity and durable root/parent cumulative
  quotas;
- cold resume consuming active but not cumulative quota;
- permit ownership retained until official quiescent cleanup;
- exact Strict/Audit mode truth and fail-closed bootstrap;
- a minimal protocol that lets external policy exist without a private fork or
  tool-specific integration API.

### Residual differentiation

The defensible contribution is:

> **DSH atomic cross-caller lifecycle admission protocol, demonstrated by one
> external reference policy kernel.**

It is not “the first DSH subagent limiter”, “a better background-agent GUI”, or
“a full scheduler”. Existing plugins are potential protocol consumers: when
they use ordinary `ctx.subagents` paths under Strict, they should receive the
same Host admission automatically.

## 5. Reframe v2 decision

Proceed, but extremely narrowly:

1. Official-facing artifact: protocol-v1 detached prepare/bind/release seam,
   exact patch, reusable conformance fixture, and lifecycle rationale.
2. External artifact: reference fail-fast policy with global/root active,
   durable root/parent cumulative limits, crash truth, and read-only evidence.
3. GUI: 20% observability and native-integration proof, not the product thesis.
4. Communication: lead with Discussion #131 and cross-caller lifecycle
   evidence; explicitly acknowledge current plugin precedents.
5. Stop conditions: if official DSH adds an equivalent shared atomic seam, or a
   plugin demonstrates unbypassable runtime-wide prepare/release ownership
   across all named paths, rerun this gate before further investment.

The user explicitly approved this Reframe v2 on 2026-08-14. It authorises local
release-candidate implementation and verification, not push, publication,
official submission, or a Discussion reply.
