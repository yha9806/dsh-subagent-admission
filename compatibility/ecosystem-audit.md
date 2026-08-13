# DSH subagent admission: novelty-and-coverage kill gate

- Observed on: 2026-08-13T19:48:43Z (UTC)
- Method: direct primary sources only — official Git repository at its exact
  HEAD, official npm registry metadata, the canonical public Discussion #131
  page and the official REST API behind it, GitHub repository search, and the
  Pi source checkout at its exact HEAD. Search absence is never treated as
  proof of non-existence; the judgment below rests on the concrete identities
  actually observed.

## 1. Official DSH source at the exact HEAD

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- HEAD: `47f943859bef60e4160492346772ded9b24f765a`
  (2026-08-13T19:38:46+08:00, "Merge pull request #2519 from
  deepseek-harness/feat/npm-public")
- Command: `git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD`
- Source checkout: shallow clone + `git checkout 47f943859bef60e4160492346772ded9b24f765a`
- Source package versions at that commit: root `@deepseek-ai/dsh-root`
  `0.1.0-rc.5`; the subagent seam package `@deepseek-ai/dsh-subagent`
  `0.1.0-rc.5` (`packages/subagent/subagent/package.json`).

Lifecycle seam locations at the exact HEAD (all under
`packages/subagent/subagent/src/`):

- Provider registration: `index.ts:369` `registerProvider(provider)` — the
  named-provider registry (`ctx.subagents`); effect-scoped, HMR-safe,
  duplicate name rejected.
- One-shot creation: `index.ts:414` `async start(name, request)` — capability,
  depth, and schema checks run before delegation, then
  `await provider.start(resolved)` materializes the child before any lifecycle
  event exists. There is no pre-materialization veto point.
- Continuable creation: `index.ts:212` `startContinuable(spec)` delegated to
  `SubagentContinuationManager.startContinuable` (`continuation.ts:403`).
- Follow-up / cold resume: `index.ts:231` `followup(...)` delegated to
  `continuation.ts:476`; a disposed continuable child is cold-resumed by
  replaying its persisted descriptor (`continuation.ts:999`).
- Lifecycle events: `subagent/start` (`index.ts:157`) and `subagent/end`
  (`index.ts:166`) are both `@mode emit`, published only after the provider
  has already established/published the child (`observeRun`). Emit-only events
  cannot deny a start.
- Cleanup: `index.ts:304` `drainContinuableDescendants` delegated to
  `continuation.ts:729` `drainDescendants`; manager-wide drain closes
  admission synchronously (`continuation.ts:696`).
- The only capacity-like stock limit is delegation depth: `depth.ts`
  (`assertSubagentMaxDepth`, `delegationDepthOf`) — recursion budget, not
  global/root breadth or concurrency. Grep for quota/admission/capacity finds
  lifecycle wording only (for example `types.ts:282` merely advises providers
  that "a shared capacity controller may delay an operation"; it is provider
  guidance, not a seam).

Conclusion: stock DSH exposes no pre-materialization admission seam where an
external plugin could veto a child start, and no global/root active caps,
cumulative quotas, or durable admission ledger.

## 2. Discussion #131

- Canonical URL: `https://github.com/deepseek-ai/deepseek-harness/discussions/131`
- REST URL: `https://api.github.com/repos/deepseek-ai/deepseek-harness/discussions/131`
- Comments REST URL: `.../discussions/131/comments` (paginated, followed to
  exhaustion; `per_page=100`)
- Observed on 2026-08-13T19:48:43Z, no token used.

| Field | Observed value |
| --- | --- |
| Title | 子代理无上限派生且嵌套会把整个 web 服务端拖死（56个） |
| REST id / number | `10606879` / `131` |
| State | `open` |
| Total comments (REST) | `2` |
| Fetched comment rows | `2` (cross-source count equality holds) |
| Votes | `5` (canonical HTML button `discussion-upvote-button-Discussion-10606879`, `aria-label="Upvote: 5"`) |
| `updated_at` | `2026-08-13T14:21:48Z` |
| Comment authors / associations | `noone89A` `NONE` (18002907), `sah1234567` `NONE` (18002922) |
| Maintainer comments | `0` (no `OWNER`/`MEMBER`/`COLLABORATOR` association) |
| Discussion author / association | `noone89A` `NONE` |

The discussion remains an open user report with no maintainer reply observed.
It is a demand anchor, not an official roadmap item or endorsement.

## 3. npm and GitHub identities

npm registry dist-tags observed 2026-08-13 (canonical `registry.npmjs.org`):

| Package | latest | next |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | `0.1.0-rc.6` |
| `@deepseek-ai/dsh-subagent` | `0.0.1-rc.1` | `0.1.0-rc.6` |

The source checkout at HEAD ships the `0.1.0-rc.5` family while npm `next` is
`0.1.0-rc.6`, so the baseline records `source-npm-diverged` instead of
promoting one current version.

Other identities used by Task 1 (all exist on npm): `@deepseek-ai/cordis`
`4.0.1`, `@deepseek-ai/schemastery` `3.18.1`,
`@deepseek-ai/dsh-typert-generator` `0.1.0-rc.6`, and the client inject
packages `@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-client-locale`,
`@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-ui-conversation`
(all publishing `0.1.0-rc.6`).

Ecosystem scan (GitHub search API + npm search, 2026-08-13):

- `topic:dsh-plugin` repositories: `605` total. None of the recently updated
  results is an admission-control kernel.
- `dsh-web-ui` is `zhu1090093659/dsh-web-ui`, "Plugin and skin collection for
  DeepSeek Harness (DSH) Web UI — task board, git graph, right-side panel,
  remote mobile UI, pet, live token stats, and skin center": a GUI/skin
  contribution, not a lifecycle admission kernel.
- Closest subagent-adjacent plugins: `shaokeyibb/dsh-plugin-product-subagents`
  (role-based providers with a permission ceiling — authorization, not
  capacity admission), `jiruidai/dsh-meta-orchestrator` (model-native
  orchestration), `HuanLinOTO/dsh-plugin-yet-another-subagent` (profile GUI),
  `LoserFox/distill` (background subagent reflection), `dsh-subagent-tree`
  (sidebar visualization).
- Curated lists `AdamPlatin123/awesome-dsh-plugins` and
  `awesome-dsh-plugin/awesome-dsh-plugin` list no lifecycle admission kernel.
- npm search for DSH admission/subagent-concurrency plugins returns only
  generic concurrency libraries (p-limit and similar); no DSH-specific
  admission package was observed.

## 4. Pi comparison at an exact source commit

- Repository: `https://github.com/earendil-works/pi.git`
- HEAD: `6f707eb36064e82af9c1320a7634f4dfad21049b`
  (2026-08-13T15:54:34+02:00, "fix(coding-agent): show managed-tool startup
  status in TUI")
- Closest subagent/concurrency mechanism:
  `packages/coding-agent/examples/extensions/subagent/index.ts` — each child
  is a fresh isolated `pi` process (process isolation by design), parallel
  task lists are capped at `MAX_PARALLEL_TASKS = 8`, and execution runs
  through a worker pool of `MAX_CONCURRENCY = 4`
  (`mapWithConcurrencyLimit`, lines 219 and 640). Community `pi-subagents`
  extensions (for example `@yzlin/pi-subagents`) add queueing and a
  configurable concurrency flag (default 4, capped 8) at extension level.

Pi is an architectural comparison, not a drop-in DSH lifecycle solution: it
has no durable root/parent quotas, no pre-materialization DSH seam, no cold-
resume admission, and its mechanism is process-per-child concurrency limiting
rather than in-process lifecycle ownership.

## 5. Three separate judgments

1. Already covered: stock DSH covers delegation depth accounting, a
   named-provider lifecycle registry, post-publication emit events, and scoped
   teardown; Pi covers process isolation plus bounded parallel pools; the
   community covers GUIs, skins, role providers, and orchestration.
2. Still unsolved for DSH: a pre-materialization capacity admission
   authority — global and per-root active caps, per-root cumulative and
   per-parent child quotas, fail-fast denials before provider work or child
   materialization, durable ownership across restart and cold resume — plus a
   versioned external-policy seam with conformance evidence. No official
   implementation or close plugin observed today provides that kernel and its
   conformance claim.
3. This project can still differentiate on: an installable external plugin
   with an Audit-vs-Strict mode truth, a minimal reference seam, and
   reproducible conformance, crash, and #131 benchmark evidence — without a
   private fork or monkey patch.

## 6. Go judgment

The residual demand survives the kill gate. Evidence-backed verdict: **Go**,
restricted to the Task 1 exact baseline and installable no-op dual-face
package skeleton.
