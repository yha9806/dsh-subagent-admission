# DSH Subagent Upstream Admission Seam Slim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Produce a separately qualified slim protocol-v1 admission patch and an official-facing design package, then promote the slim patch as the local exact-target Strict artifact only after lifecycle, cancellation, size, compatibility, packed-install, and evidence gates all pass.

**Architecture:** Keep policy, lineage resolution, durable quotas, telemetry, and GUI in the external dsh-subagent-admission plugin. Add only one versioned registration and permit lifecycle to the official SubagentRuntime. The runtime acquires before provider or Agent materialisation, binds after official publication, and releases only after startup rollback or canonical quiescence. Preserve the existing reference patch as a recoverable artifact throughout candidate development.

**Tech Stack:** TypeScript 6, Node.js 22.19 or 24+, pnpm 11.7.0, Vitest 4, oxlint, exact DeepSeek Harness source commit 47f943859bef60e4160492346772ded9b24f765a, Git patches, SHA-256 evidence.

## Global Constraints

- Work only in /Users/yhryzy/Documents/ChatGPT/deepseek- harness/.worktrees/dsh-subagent-admission-v0.1 on branch codex/dsh-subagent-admission-v0.1.
- Treat docs/superpowers/specs/2026-08-14-dsh-subagent-upstream-seam-slim-design.md as the approved semantic source of truth.
- Do not push, tag, publish npm, post to Discussion #131, send LinkedIn messages, open a PR, or change any remote state.
- Keep patches/dsh-subagent-admission-seam.patch byte-identical until the final promotion task. Preserve it after promotion as the reference artifact.
- Build the slim candidate from the clean exact official source. Do not obtain the size reduction by deleting lifecycle checks, failure aggregation, cancellation checks, tests, or invariant comments.
- Keep the official patch restricted to these three files:
  - packages/subagent/subagent/src/types.ts
  - packages/subagent/subagent/src/index.ts
  - packages/subagent/subagent/src/continuation.ts
- A passing focused test is development evidence only. Qualification requires the complete official package tests and complete reusable upstream fixture.
- A model is not part of any verification path. Keep external model calls and API keys at zero.
- Stock Audit, patched Strict, native GUI, CI configuration, remote CI execution, publication, maintainer response, official adoption, and employment interest remain separate evidence classes.
- Use apply_patch for every source or documentation edit. Formatting and generated patch inspection may use normal read-only commands, but do not create tracked files through shell redirection.
- Stage only files named by the current task. Make one local descriptive commit after each coherent green milestone.
- If the exact source identity, npm identity, or Discussion baseline drifts, stop promotion. Do not silently retarget the patch or rewrite the evidence claim.

## Planned File Structure

Files to create:

~~~text
scripts/seam-patch-tooling.ts
scripts/check-seam-patch-size.mts
tests/seam-patch-tooling.spec.ts
patches/dsh-subagent-admission-seam-slim.patch
docs/upstream-agent-note.md
docs/discussion-131-draft.md
~~~

Files to modify while qualifying the candidate:

~~~text
scripts/verify-seam-patch.mts
tests/upstream/admission-policy.spec.ts
packages/dsh-subagent-admission/src/host/seam-v1.ts
packages/dsh-subagent-admission/src/host/authority.ts
packages/dsh-subagent-admission/src/host/root-resolver.ts
packages/dsh-subagent-admission/src/host/service.ts
packages/dsh-subagent-admission/tests/config.spec.ts
packages/dsh-subagent-admission/tests/authority.spec.ts
packages/dsh-subagent-admission/tests/root-resolver.spec.ts
packages/dsh-subagent-admission/tests/service.spec.ts
tests/crash/child.mts
tests/crash/restart.e2e.ts
scripts/run-strict-conformance.mts
scripts/packed-install.mts
scripts/release-evidence.mts
tests/packed-install-command.spec.ts
tests/docs.spec.ts
README.md
README.zh-CN.md
packages/dsh-subagent-admission/README.md
packages/dsh-subagent-admission/README.zh-CN.md
docs/upstream-seam.md
docs/compatibility.md
compatibility/ecosystem-audit.md
~~~

Files modified only at promotion:

~~~text
compatibility/baseline.json
CHANGELOG.md
~~~

The package README files are generated from the root documents by scripts/sync-package-docs.mts. Edit the root README files first, then run the sync command.

---

### Task 1: Add dual-patch verification and deterministic size gates

**Interfaces**

- Consumes: the existing exact-source baseline, reference patch, reusable upstream fixture, and current verifier.
- Produces: one shared reference/slim patch catalog, a deterministic diff-metric parser, a size-check CLI, and a verifier that can run stock, reference, slim, or a clearly labelled focused development subset.

**Files**

- Create: scripts/seam-patch-tooling.ts
- Create: scripts/check-seam-patch-size.mts
- Create: tests/seam-patch-tooling.spec.ts
- Modify: scripts/verify-seam-patch.mts

- [ ] **Step 1: Write failing unit tests for patch identity and metrics**

Add tests that require:

1. only the names reference and slim are accepted;
2. reference resolves to patches/dsh-subagent-admission-seam.patch;
3. slim resolves to patches/dsh-subagent-admission-seam-slim.patch;
4. numeric Git numstat rows are parsed exactly;
5. binary or malformed rows fail loud;
6. only the three approved official paths are accepted;
7. total changed lines are insertions plus deletions;
8. continuation.ts changed lines are measured independently;
9. slim rejects more than 3 files, more than 313 changed lines, more than 140 continuation lines, or more than 455 serialized lines.

Use this test shape:

~~~ts
import { describe, expect, it } from 'vitest'

import {
  assertSlimPatchMetrics,
  parseGitNumstat,
  parseSeamPatchName,
  seamPatch,
  summarizePatch,
} from '../scripts/seam-patch-tooling.js'

describe('seam patch tooling', () => {
  it('resolves only the two named artifacts', () => {
    expect(parseSeamPatchName('reference')).toBe('reference')
    expect(parseSeamPatchName('slim')).toBe('slim')
    expect(() => parseSeamPatchName('candidate')).toThrow(
      'patch must be reference or slim',
    )
    expect(seamPatch('reference').relativePath)
      .toBe('patches/dsh-subagent-admission-seam.patch')
    expect(seamPatch('slim').relativePath)
      .toBe('patches/dsh-subagent-admission-seam-slim.patch')
  })

  it('measures changed and serialized lines without guessing', () => {
    const rows = parseGitNumstat([
      '100\t20\tpackages/subagent/subagent/src/continuation.ts',
      '120\t10\tpackages/subagent/subagent/src/index.ts',
      '40\t0\tpackages/subagent/subagent/src/types.ts',
    ].join('\n'))
    const metrics = summarizePatch(rows, 450)
    expect(metrics).toEqual({
      files: 3,
      insertions: 260,
      deletions: 30,
      changedLines: 290,
      continuationChangedLines: 120,
      serializedPatchLines: 450,
    })
    expect(() => assertSlimPatchMetrics(metrics)).not.toThrow()
  })

  it.each([
    [{ files: 4 }, 'official files 4 exceeds 3'],
    [{ changedLines: 314 }, 'changed lines 314 exceeds 313'],
    [{ continuationChangedLines: 141 }, 'continuation changed lines 141 exceeds 140'],
    [{ serializedPatchLines: 456 }, 'serialized patch lines 456 exceeds 455'],
  ])('rejects a failed slim threshold', (change, message) => {
    const metrics = {
      files: 3,
      insertions: 270,
      deletions: 30,
      changedLines: 300,
      continuationChangedLines: 130,
      serializedPatchLines: 440,
      ...change,
    }
    expect(() => assertSlimPatchMetrics(metrics)).toThrow(message)
  })
})
~~~

- [ ] **Step 2: Run the new test and confirm RED**

Run:

~~~bash
pnpm exec vitest run tests/seam-patch-tooling.spec.ts
~~~

Expected: FAIL because scripts/seam-patch-tooling.ts does not exist.

- [ ] **Step 3: Implement the shared patch catalog and metric parser**

Create scripts/seam-patch-tooling.ts with these public shapes:

~~~ts
export type SeamPatchName = 'reference' | 'slim'

export const DEFAULT_SEAM_PATCH: SeamPatchName = 'reference'

export const OFFICIAL_SEAM_FILES = Object.freeze([
  'packages/subagent/subagent/src/continuation.ts',
  'packages/subagent/subagent/src/index.ts',
  'packages/subagent/subagent/src/types.ts',
] as const)

export interface SeamPatchDefinition {
  readonly name: SeamPatchName
  readonly relativePath: string
}

export interface PatchNumstatRow {
  readonly path: string
  readonly insertions: number
  readonly deletions: number
}

export interface PatchMetrics {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
  readonly changedLines: number
  readonly continuationChangedLines: number
  readonly serializedPatchLines: number
}
~~~

Implement parseSeamPatchName as an exact two-value parser. Implement parseGitNumstat by splitting non-empty lines on tab, rejecting non-decimal counts, duplicate paths, and paths outside OFFICIAL_SEAM_FILES. Implement summarizePatch as a pure reducer. Implement assertSlimPatchMetrics with the four exact threshold messages used by the tests.

- [ ] **Step 4: Implement the size CLI**

Create scripts/check-seam-patch-size.mts. It must:

- accept exactly --patch reference or --patch slim;
- accept optional --enforce-slim only when --patch slim is selected;
- run git apply --numstat against the selected file;
- count serialized lines from the patch bytes;
- calculate SHA-256;
- print one schemaVersion 1 JSON report;
- call assertSlimPatchMetrics only under --enforce-slim.

The successful report type is:

~~~ts
interface PatchSizeReport {
  readonly schemaVersion: 1
  readonly status: 'measured'
  readonly patch: SeamPatchName
  readonly patchPath: string
  readonly patchSha256: string
  readonly metrics: PatchMetrics
  readonly slimQualified: boolean
}
~~~

The CLI must emit measured integers from the selected patch, validate patchSha256 against /^[0-9a-f]{64}$/, and never hard-code candidate results.

- [ ] **Step 5: Extend the verifier CLI without changing its default**

Change scripts/verify-seam-patch.mts to parse:

~~~text
verify-seam-patch.mts [--patch reference|slim] [--focus one-shot]
verify-seam-patch.mts --expect-unpatched-failure
~~~

Rules:

- default patch remains reference;
- --expect-unpatched-failure cannot be combined with --patch or --focus;
- --focus one-shot adds a Vitest name pattern matching only protocol-v1 registration and one-shot admission ownership;
- focused output uses status focused-pass, never pass;
- full patched output uses status pass;
- the official test process receives DSH_ADMISSION_SEAM_SHAPE=reference or slim;
- the output records patchName, patchPath, patchSha256, focus, and the exact invoked command;
- missing candidate patch fails before creating a disposable worktree.

Extend the command helper to accept a narrow env override:

~~~ts
interface CommandOptions {
  readonly print?: boolean
  readonly env?: NodeJS.ProcessEnv
}

env: {
  ...process.env,
  ...options.env,
  CI: '1',
}
~~~

- [ ] **Step 6: Run tooling tests and current reference verification**

Run:

~~~bash
pnpm exec vitest run tests/seam-patch-tooling.spec.ts
pnpm exec tsx scripts/check-seam-patch-size.mts --patch reference
pnpm exec tsx scripts/verify-seam-patch.mts --patch reference
~~~

Expected:

- tooling tests PASS;
- the reference report records 3 files, 380 insertions, 38 deletions, 418 changed lines, and 187 changed continuation lines;
- the complete reference verifier PASS remains unchanged semantically.

- [ ] **Step 7: Commit the green tooling milestone**

Run:

~~~bash
git add scripts/seam-patch-tooling.ts scripts/check-seam-patch-size.mts scripts/verify-seam-patch.mts tests/seam-patch-tooling.spec.ts
git commit -m "test: add dual seam patch qualification gates"
~~~

---

### Task 2: Make one reusable upstream fixture prove both protocol shapes

**Interfaces**

- Consumes: the reference runtime contract using prepare and the approved slim contract using acquire(request, signal).
- Produces: one reusable official-package fixture that keeps reference recovery green while adding slim-only cancellation proofs.

**Files**

- Modify: tests/upstream/admission-policy.spec.ts

- [ ] **Step 1: Add a strict fixture-shape selector**

At module load, parse DSH_ADMISSION_SEAM_SHAPE:

~~~ts
type SeamShape = 'reference' | 'slim'

const SEAM_SHAPE = process.env.DSH_ADMISSION_SEAM_SHAPE
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
~~~

Do not infer the shape from method presence.

- [ ] **Step 2: Make RecordingPolicy implement both draft entry points**

Keep one permit-record implementation and expose both methods:

~~~ts
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
~~~

Class methods may include members beyond the currently imported interface, so
this single class typechecks against both official drafts. Replace every
remaining inline policy object in the fixture with a small local class that
defines both prepare and acquire; a skipped slim-only test must still compile
against the reference types.

All ordinary expectations must use:

~~~ts
const admissionEvent = (operation: string): string =>
  (SEAM_SHAPE === 'slim' ? 'acquire:' : 'prepare:') + operation

const quiescentReason: ObservedReleaseReason =
  SEAM_SHAPE === 'slim' ? 'quiescent' : 'disposed'
~~~

- [ ] **Step 3: Rename fixture language from prepare to acquire-neutral admission**

Rename test descriptions and comments so behavioral assertions say:

- admission occurs before provider work;
- publication binds the child;
- result settlement is not release evidence;
- canonical disposal releases at quiescence.

Retain reference-specific event expectations only through the two helpers above.

- [ ] **Step 4: Add exact-signal and pre-provider cancellation tests**

Add slim-only tests with it.skipIf(SEAM_SHAPE === 'reference').

The exact-signal test registers a policy whose acquire records the signal and returns a permit. Pass one AbortController.signal to runtime.start and assert identity with toBe.

The cancellation-after-acquire test must abort inside acquire immediately before returning the permit:

~~~ts
it.skipIf(SEAM_SHAPE === 'reference')(
  'releases after cancellation wins following acquire and starts no provider',
  async () => {
    const { runtime } = await bareRuntime()
    const controller = new AbortController()
    const events: string[] = []
    let starts = 0
    runtime.registerAdmissionPolicy({
      protocolVersion: 1,
      prepare: async (): Promise<never> => {
        throw new Error('reference-only method must stay skipped')
      },
      acquire: async (_request, signal) => {
        expect(signal).toBe(controller.signal)
        events.push('acquire')
        controller.abort()
        return {
          bindChild: (): void => {
            events.push('bind')
          },
          release: async (reason): Promise<void> => {
            events.push('release:' + reason)
          },
        }
      },
    })
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
~~~

- [ ] **Step 5: Add post-publication cancellation rollback**

Use bindChild to abort the caller signal. The dual-shape policy object must also define a throwing prepare method so the skipped test still typechecks against the reference patch. The provider must already have returned a run. Assert this order:

~~~text
acquire
provider
bind
provider-disposed
release:startup-failed
~~~

Assert runtime.start rejects with AbortError and returns no run to the caller. This proves caller cancellation causes official rollback before release rather than directly refunding a live child.

- [ ] **Step 6: Run stock RED and reference GREEN**

Run:

~~~bash
pnpm exec tsx scripts/verify-seam-patch.mts --expect-unpatched-failure
pnpm exec tsx scripts/verify-seam-patch.mts --patch reference
~~~

Expected:

- stock exact source FAILS for the missing registration surface;
- reference full fixture PASSES;
- slim-only cancellation rows are skipped only in the explicitly labelled reference run.

- [ ] **Step 7: Commit the reusable fixture**

Run:

~~~bash
git add tests/upstream/admission-policy.spec.ts
git commit -m "test: specify cancellable slim admission contract"
~~~

---

### Task 3: Adopt the slim contract in the external policy without breaking reference recovery

**Interfaces**

- Consumes: acquire(request, signal), release(startup-failed or quiescent), durable lineage resolution, serialized quota admission, and the old reference patch during migration.
- Produces: a cancellation-aware policy implementation, signal-aware root resolver, normalized telemetry, and one temporary JavaScript compatibility bridge for the recoverable reference patch.

**Files**

- Modify: packages/dsh-subagent-admission/src/host/seam-v1.ts
- Modify: packages/dsh-subagent-admission/src/host/authority.ts
- Modify: packages/dsh-subagent-admission/src/host/root-resolver.ts
- Modify: packages/dsh-subagent-admission/src/host/service.ts
- Modify: packages/dsh-subagent-admission/tests/config.spec.ts
- Modify: packages/dsh-subagent-admission/tests/authority.spec.ts
- Modify: packages/dsh-subagent-admission/tests/root-resolver.spec.ts
- Modify: packages/dsh-subagent-admission/tests/service.spec.ts
- Modify: tests/crash/child.mts
- Modify: tests/crash/restart.e2e.ts

- [ ] **Step 1: Change type tests to the approved contract**

Update config.spec.ts to require:

~~~ts
expectTypeOf<
  Parameters<SubagentAdmissionPermitV1['release']>[0]
>().toEqualTypeOf<'startup-failed' | 'quiescent'>()

expectTypeOf<
  Parameters<SubagentAdmissionPolicyV1['acquire']>
>().toEqualTypeOf<[
  request: Readonly<SubagentAdmissionRequestV1>,
  signal: AbortSignal,
]>()

expectTypeOf<
  ReturnType<SubagentAdmissionPolicyV1['acquire']>
>().toEqualTypeOf<Promise<SubagentAdmissionPermitV1>>()
~~~

Run:

~~~bash
pnpm exec vitest run packages/dsh-subagent-admission/tests/config.spec.ts
~~~

Expected: FAIL on the old release union and prepare method.

- [ ] **Step 2: Replace the local structural mirror**

In seam-v1.ts, keep the request and binding fields unchanged and replace only:

~~~ts
export type SubagentAdmissionReleaseReasonV1 =
  | 'startup-failed'
  | 'quiescent'

export interface SubagentAdmissionPermitV1 {
  bindChild(binding: {
    readonly childSessionId: string
    readonly localParentSessionId?: string
  }): void
  release(reason: SubagentAdmissionReleaseReasonV1): Promise<void>
}

export interface SubagentAdmissionPolicyV1 {
  readonly protocolVersion: 1
  acquire(
    request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1>
}
~~~

- [ ] **Step 3: Write authority cancellation tests before implementation**

Extend FakeRoots.resolve to receive and record an optional AbortSignal. Add tests proving:

1. a pre-aborted signal causes no guard, root, ledger, or lease mutation;
2. abort after the guard but before root resolution completes causes no ledger write;
3. abort after root resolution but before reserveNew causes no durable write;
4. once reserveNew begins, the bounded atomic ledger-plus-lease section completes and the caller receives a permit for runtime-owned startup release;
5. acquire receives the exact caller signal.

Do not add a cancellation checkpoint between a successful durable reserveNew and process-local lease insertion. That would commit cumulative truth without returning a releasable permit.

- [ ] **Step 4: Implement AdmissionAuthority.acquire with safe checkpoints**

Rename prepare to acquire for the public protocol path. Use this ordering inside the existing SerialSection:

~~~ts
const request = this.validateRequest(rawRequest)
signal.throwIfAborted()
this.assertOpen(request, resolvedRootId)
signal.throwIfAborted()
await this.guard.assertHeld()
signal.throwIfAborted()
const lineage = await this.roots.resolve(
  request.parentSessionId,
  signal,
)
signal.throwIfAborted()
~~~

Then run child collision, clock, active-capacity, ledger, and lease insertion exactly as before. Do not check the signal after the ledger commit and before lease insertion.

Add one migration bridge that is not part of seam-v1.ts:

~~~ts
const REFERENCE_PATCH_SIGNAL = new AbortController().signal

/**
 * Temporary runtime bridge for the retained reference patch. The canonical
 * protocol surface is acquire(request, signal).
 */
prepare(
  request: SubagentAdmissionRequestV1,
): Promise<SubagentAdmissionPermitV1> {
  return this.acquire(request, REFERENCE_PATCH_SIGNAL)
}
~~~

The bridge exists so the old verified patch remains executable during candidate qualification. Do not document prepare as part of protocol v1.

- [ ] **Step 5: Normalize old reference release calls at the permit object**

Keep the public release type narrow. Let the concrete AdmissionPermit accept a private migration union:

~~~ts
type ReferenceReleaseReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'disposed'

type RuntimeReleaseReason =
  | AdmissionReleaseReason
  | ReferenceReleaseReason

function normalizeReleaseReason(
  reason: RuntimeReleaseReason,
): AdmissionReleaseReason {
  return reason === 'startup-failed'
    ? 'startup-failed'
    : 'quiescent'
}
~~~

Normalize before the first release callback and before duplicate-release telemetry. New tests and all external policy code must use only startup-failed or quiescent. Add one explicit migration test showing an old disposed callback is observed as quiescent exactly once.

- [ ] **Step 6: Add signal-aware durable root resolution**

Change the interfaces to:

~~~ts
export interface SessionHeaderReader {
  inspect(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<
    { readonly id: string; readonly parentSession?: string } | undefined
  >
}

export interface RootResolution {
  resolve(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedLineage>
  bindChild(input: ChildBindingInput): void
}
~~~

DurableRootResolver.resolve must:

- call signal.throwIfAborted before consulting its memoized map;
- pass the signal to every inspect;
- call signal.throwIfAborted immediately after every awaited inspect;
- memoize nothing on abort or partial traversal.

The check before the memoized return is mandatory. Cancellation must not be bypassed merely because lineage was cached.

- [ ] **Step 7: Test cache and in-flight cancellation**

Add two root-resolver tests:

1. resolve and cache one lineage, abort a new signal, then prove the cached lookup rejects with AbortError and performs no new inspect;
2. block inspect, abort while it is pending, release the block, prove the result rejects and a later fresh resolve performs the inspect again.

Also assert the reader receives the exact signal object.

- [ ] **Step 8: Thread the signal through BootstrapHeaders**

Change BootstrapHeaders.inspect in service.ts to accept an optional signal. Check it before live or cached return, pass it to persistence.inspect, and check it after the await. Bootstrap calls without a signal retain their current behavior.

- [ ] **Step 9: Update direct policy callers and release vocabulary**

Mechanically replace direct authority.prepare calls in package tests and crash fixtures with:

~~~ts
authority.acquire(request, new AbortController().signal)
~~~

Replace successful disposal releases with:

~~~ts
permit.release('quiescent')
~~~

Keep startup rollback tests on startup-failed. Rename test descriptions from concurrent prepares to concurrent acquires and from prepare ordering to acquire ordering.

- [ ] **Step 10: Run focused plugin and migration verification**

Run:

~~~bash
pnpm exec vitest run \
  packages/dsh-subagent-admission/tests/config.spec.ts \
  packages/dsh-subagent-admission/tests/authority.spec.ts \
  packages/dsh-subagent-admission/tests/root-resolver.spec.ts \
  packages/dsh-subagent-admission/tests/service.spec.ts \
  tests/crash/restart.e2e.ts
pnpm typecheck
pnpm exec tsx scripts/run-strict-conformance.mts
~~~

Expected:

- targeted tests PASS;
- typecheck PASS;
- current reference-patch Strict conformance still PASS through the temporary prepare and release normalization bridge.

- [ ] **Step 11: Audit the migration surface**

Run:

~~~bash
rg -n "release\\('(completed|aborted|error|disposed)'|\\.prepare\\(" \
  packages/dsh-subagent-admission/src \
  packages/dsh-subagent-admission/tests \
  tests/crash
~~~

Expected: only the documented reference bridge and its one migration test remain. No new protocol type or normal test uses the old vocabulary.

- [ ] **Step 12: Commit the external contract milestone**

Run:

~~~bash
git add \
  packages/dsh-subagent-admission/src/host/seam-v1.ts \
  packages/dsh-subagent-admission/src/host/authority.ts \
  packages/dsh-subagent-admission/src/host/root-resolver.ts \
  packages/dsh-subagent-admission/src/host/service.ts \
  packages/dsh-subagent-admission/tests/config.spec.ts \
  packages/dsh-subagent-admission/tests/authority.spec.ts \
  packages/dsh-subagent-admission/tests/root-resolver.spec.ts \
  packages/dsh-subagent-admission/tests/service.spec.ts \
  tests/crash/child.mts \
  tests/crash/restart.e2e.ts
git commit -m "feat: adopt cancellable admission acquire contract"
~~~

---

### Task 4: Build and qualify the slim one-shot slice

**Interfaces**

- Consumes: clean exact official source, approved detached protocol types, one-shot provider validation and lifecycle, and the focused upstream fixture.
- Produces: a partial candidate patch whose protocol registration and one-shot path pass focused official tests, while continuable qualification remains explicitly incomplete.

**Files**

- Create: patches/dsh-subagent-admission-seam-slim.patch
- Temporary exact-source edits:
  - packages/subagent/subagent/src/types.ts
  - packages/subagent/subagent/src/index.ts

- [ ] **Step 1: Create or verify one clean exact-source development worktree**

Use this exact temporary path:

~~~text
/Users/yhryzy/Documents/ChatGPT/deepseek- harness/.worktrees/dsh-subagent-admission-v0.1/.cache/deepseek-harness-slim-dev
~~~

If it exists, verify HEAD equals 47f943859bef60e4160492346772ded9b24f765a and git status is clean. If either check fails, stop rather than deleting unknown work.

If it does not exist, run:

~~~bash
git -C .cache/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a \
  worktree add --detach \
  "/Users/yhryzy/Documents/ChatGPT/deepseek- harness/.worktrees/dsh-subagent-admission-v0.1/.cache/deepseek-harness-slim-dev" \
  47f943859bef60e4160492346772ded9b24f765a
~~~

- [ ] **Step 2: Add the exact protocol types to the temporary official source**

In src/types.ts, add exactly the public contract from the approved spec:

~~~ts
export type SubagentAdmissionOperationV1 =
  | 'new-one-shot'
  | 'new-continuable'
  | 'cold-resume'

export type SubagentAdmissionReleaseReasonV1 =
  | 'startup-failed'
  | 'quiescent'

export interface SubagentAdmissionChildBindingV1 {
  readonly childSessionId: string
  readonly localParentSessionId?: string
}

export interface SubagentAdmissionRequestV1 {
  readonly requestId: string
  readonly operation: SubagentAdmissionOperationV1
  readonly provider: string
  readonly parentSessionId: string
  readonly childSessionId?: string
}

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
~~~

Export the six types from index.ts.

- [ ] **Step 3: Add one tri-state policy slot and registration**

Use:

~~~ts
readonly admissionProtocolVersion = 1 as const

private admissionPolicy:
  | SubagentAdmissionPolicyV1
  | null
  | undefined
~~~

Registration validation must check explicit protocolVersion and acquire before assigning the slot. The disposer changes the same active object to null. Any object or null state rejects another registration with DUPLICATE_ADMISSION_POLICY.

The acquisition helper must preserve the no-policy fast path:

~~~ts
private acquireAdmission(
  request: Omit<SubagentAdmissionRequestV1, 'requestId'>,
  signal: AbortSignal,
): Promise<SubagentAdmissionPermitV1> | undefined {
  const policy = this.admissionPolicy
  if (policy === undefined) return undefined
  signal.throwIfAborted()
  if (policy === null) {
    throw new SubagentError(
      'subagent admission policy is closed; restart the runtime',
      'ADMISSION_CLOSED',
    )
  }
  return policy.acquire(
    Object.freeze({ requestId: randomUUID(), ...request }),
    signal,
  )
}
~~~

- [ ] **Step 4: Add concise one-shot failure helpers**

Implement:

~~~ts
async function rejectAfterPermitRelease(
  failure: unknown,
  permit: SubagentAdmissionPermitV1,
): Promise<never> {
  try {
    await permit.release('startup-failed')
  } catch (releaseFailure: unknown) {
    throw new AggregateError(
      [failure, releaseFailure],
      'subagent startup and admission release both failed',
    )
  }
  throw failure
}

async function rejectAfterRunRollback(
  failure: unknown,
  run: SubagentRun,
  permit: SubagentAdmissionPermitV1,
): Promise<never> {
  void run.result.catch(() => undefined)
  try {
    await run.dispose()
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [failure, cleanupFailure],
      'subagent startup and publication rollback both failed',
    )
  }
  return rejectAfterPermitRelease(failure, permit)
}

function holdPermit(
  run: SubagentRun,
  permit: SubagentAdmissionPermitV1,
): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result,
    dispose: () => disposal ??= (async () => {
      await run.dispose()
      await permit.release('quiescent')
    })(),
  }
}
~~~

If run.dispose rejects, holdPermit must not call release. If release rejects, the memoized disposal rejects on every caller.

- [ ] **Step 5: Integrate one-shot acquisition without changing stock identity**

After existing provider, capability, depth, schema, and descriptor validation:

~~~ts
const acquiring = this.acquireAdmission({
  operation: 'new-one-shot',
  provider: name,
  parentSessionId: request.parent.id,
}, request.signal)

if (acquiring === undefined) {
  return observeRun(
    this.emitLifecycle,
    name,
    request.parent,
    await provider.start(resolved),
  )
}

const permit = await acquiring
let run: SubagentRun | undefined
try {
  request.signal.throwIfAborted()
  run = await provider.start(resolved)
  request.signal.throwIfAborted()
  const localParentSessionId =
    run.localAgent?.session.header.parentSession
  permit.bindChild({
    childSessionId: run.id,
    ...(localParentSessionId === undefined
      ? {}
      : { localParentSessionId }),
  })
  request.signal.throwIfAborted()
} catch (error: unknown) {
  return run === undefined
    ? rejectAfterPermitRelease(error, permit)
    : rejectAfterRunRollback(error, run, permit)
}

return observeRun(
  this.emitLifecycle,
  name,
  request.parent,
  holdPermit(run, permit),
)
~~~

The two post-provider checks are required: cancellation can win after acquire or after publication/binding, but before ownership is returned to the caller.

- [ ] **Step 6: Materialize the partial tracked patch**

Inspect the exact two-file diff with git diff --check and git diff --stat. Then use apply_patch to create patches/dsh-subagent-admission-seam-slim.patch from that reviewed Git diff. Do not use shell redirection.

- [ ] **Step 7: Run focused one-shot RED/GREEN**

Before the index integration is complete, run:

~~~bash
pnpm exec tsx scripts/verify-seam-patch.mts \
  --patch slim \
  --focus one-shot
~~~

Expected RED: registration or one-shot behavior fails.

After implementation, run the same command again.

Expected GREEN:

- status is focused-pass;
- registration, tombstone, unsupported protocol, cancellation, binding, rollback, no-policy identity, and quiescent release rows pass;
- this output is not accepted as full slim qualification.

- [ ] **Step 8: Report partial size without qualifying it**

Run:

~~~bash
pnpm exec tsx scripts/check-seam-patch-size.mts --patch slim
~~~

Expected: a measured report only. Do not use --enforce-slim until continuation semantics are present.

- [ ] **Step 9: Keep the focused slice explicitly uncommitted**

Run:

~~~bash
git status --short \
  patches/dsh-subagent-admission-seam-slim.patch
~~~

Expected: the candidate patch is present as an uncommitted development
artifact. A focused one-shot pass is not a complete result, so do not commit it
until Task 5 finishes full official and size qualification.

---

### Task 5: Complete continuable and cold-resume lifecycle ownership

**Interfaces**

- Consumes: the partial slim patch, continuation manager lifecycle, stable child IDs, persisted descriptors, canonical child-first disposal, and the full upstream fixture.
- Produces: a complete candidate patch passing all official tests and every semantic and size gate.

**Files**

- Modify: patches/dsh-subagent-admission-seam-slim.patch
- Temporary exact-source edits:
  - packages/subagent/subagent/src/index.ts
  - packages/subagent/subagent/src/continuation.ts

- [ ] **Step 1: Extend ContinuationHost with validation and acquisition**

Add:

~~~ts
interface ContinuationHost {
  assertContinuableProvider(name: string): void
  acquireAdmission(
    request: Omit<SubagentAdmissionRequestV1, 'requestId'>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1> | undefined
  prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec>
  observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver
}
~~~

In index.ts, provide these callbacks and split expectContinuableProvider from prepareContinuable so missing providers and missing capabilities fail before admission.

- [ ] **Step 2: Attach one optional permit to MaterializeInputs and Activation**

Add:

~~~ts
interface Activation {
  readonly admissionPermit: SubagentAdmissionPermitV1 | undefined
}

interface MaterializeInputs {
  readonly admissionPermit: SubagentAdmissionPermitV1 | undefined
}
~~~

The permit is process-local ownership. Never persist it, serialize it, copy it into a Session event, or expose it to a provider.

- [ ] **Step 3: Add one continuation startup-release helper**

Use the same failure aggregation rule as one-shot:

~~~ts
async function rejectAfterAdmissionRelease(
  failure: unknown,
  permit: SubagentAdmissionPermitV1,
): Promise<never> {
  try {
    await permit.release('startup-failed')
  } catch (releaseFailure: unknown) {
    throw new AggregateError(
      [failure, releaseFailure],
      'continuable startup and admission release both failed',
    )
  }
  throw failure
}
~~~

- [ ] **Step 4: Acquire fresh continuable admission after pure validation**

Required order:

1. parent/drain, persistence, depth, child ID, descriptor, and provider capability validation;
2. acquire with operation new-continuable and the stable child ID;
3. recheck caller signal;
4. call provider.prepareContinuable;
5. recheck signal and parent admission;
6. enter the child lock;
7. transfer the permit to materialize;
8. submit the first message.

Use a boolean that distinguishes errors before materialize takes ownership:

~~~ts
const acquiring = this.host.acquireAdmission({
  operation: 'new-continuable',
  provider: spec.provider,
  parentSessionId: parent.id,
  childSessionId: childId,
}, spec.signal)
const permit = acquiring === undefined ? undefined : await acquiring
let materializeOwnsPermit = false

try {
  spec.signal.throwIfAborted()
  const prepared = await this.host.prepareContinuable(
    spec.provider,
    { sessionId: childId, parent, signal: spec.signal },
  )
  spec.signal.throwIfAborted()
  this.assertAdmitting(parent)
  const lineageSeedLength = prepared.seed?.length ?? 0
  const seed = seedDescriptorTurn(
    childId,
    prepared.seed,
    descriptor,
  )
  const messageId = await this.locks.run(childId, async () => {
    materializeOwnsPermit = true
    const activation = await this.materialize({
      childId,
      provider: spec.provider,
      parent,
      admissionPermit: permit,
      create: {
        seed,
        meta: childSessionMeta(
          parent,
          childDepth,
          lineageSeedLength,
        ),
        delegatedPolicies,
      },
      agentOptions: resolveChildAgentOptions(
        parent,
        request.agentOptions,
        childDepth,
      ),
      composition: {
        persona: request.persona,
        toolFilter: request.toolFilter,
      },
      signal: spec.signal,
    })
    return this.submitMaterialized(
      activation,
      request.prompt,
      { kind: 'user' },
      parent,
      spec.signal,
    )
  })
  return { childId, messageId }
} catch (error: unknown) {
  if (permit !== undefined && !materializeOwnsPermit) {
    return rejectAfterAdmissionRelease(error, permit)
  }
  throw error
}
~~~

These existing expressions remain authoritative. Do not replace them with new abstractions merely to shorten the patch.

- [ ] **Step 5: Acquire cold-resume admission only after lineage authorization**

Keep persistence.inspect, signal checks, assertAdmitting, authorizeLineage, descriptor folding, and descriptor-mode rejection before acquire. Then acquire:

~~~ts
const acquiring = this.host.acquireAdmission({
  operation: 'cold-resume',
  provider: descriptor.provider,
  parentSessionId: parent.id,
  childSessionId: childId,
}, options.signal)
const permit = acquiring === undefined ? undefined : await acquiring
options.signal.throwIfAborted()
~~~

Pass the permit into materialize. Resident follow-up must not call acquireAdmission; the existing resident branch continues to reuse its Activation.

In the existing cold-resume materialization catch, preserve an AggregateError
before rethrowing caller cancellation:

~~~ts
} catch (error: unknown) {
  if (error instanceof AggregateError) throw error
  options.signal.throwIfAborted()
  if (error instanceof SubagentError) throw error
  throw new SubagentError(
    'subagent "' + childId + '" is unavailable',
    'NOT_RESUMABLE',
    { cause: error },
  )
}
~~~

This keeps a simultaneous startup and permit-release failure observable instead
of replacing it with the caller AbortError.

- [ ] **Step 6: Make materialize own every failure after transfer**

Wrap Agent create or resume so a failure before a handle exists releases startup admission:

~~~ts
let handle: AgentHandle
try {
  handle = create === undefined
    ? await this.ownerCtx.agents.resume({
        resumeSessionId: childId,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })
    : await this.ownerCtx.agents.create({
        sessionId: childId,
        meta: create.meta,
        seed: create.seed,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })
} catch (error: unknown) {
  if (admissionPermit !== undefined) {
    return rejectAfterAdmissionRelease(error, admissionPermit)
  }
  throw error
}
~~~

Use the existing create and resume option objects inline if extracting them would increase the diff.

After the Activation is inserted, bind before caller success:

~~~ts
const localParentSessionId =
  handle.agent.session.header.parentSession
admissionPermit?.bindChild({
  childSessionId,
  ...(localParentSessionId === undefined
    ? {}
    : { localParentSessionId }),
})
inputs.signal.throwIfAborted()
~~~

If binding, cancellation, parent ownership, listener setup, or lifecycle publication fails, call rollbackUnpublished. If rollback fails, throw an AggregateError containing the startup and rollback failures. Never catch and discard rollback failure.

- [ ] **Step 7: Release unpublished rollback only after handle cleanup**

Modify rollbackUnpublished so it:

1. awaits handle.dispose;
2. removes the Activation and ownership edge in finally;
3. releases startup-failed only when handle.dispose succeeded;
4. propagates cleanup or release failure.

This is the required structure:

~~~ts
private rollbackUnpublished(
  activation: Activation,
): Promise<void> {
  return activation.disposal ??= (async () => {
    let quiescent = false
    try {
      await activation.handle.dispose()
      quiescent = true
    } finally {
      this.activations.delete(activation.childId)
      this.releaseOwnership(activation.childId)
    }
    if (quiescent) {
      await activation.admissionPermit?.release('startup-failed')
    }
  })()
}
~~~

- [ ] **Step 8: Make failed initial submission observable**

Replace the catch-and-discard rollback in submitMaterialized:

~~~ts
} catch (error: unknown) {
  try {
    await this.dispose(activation)
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [error, cleanupFailure],
      'continuable submission and rollback both failed',
    )
  }
  throw error
}
~~~

Because announced remains false until submit succeeds, finishDisposal can distinguish startup rollback from a normal resident lifecycle.

- [ ] **Step 9: Release at canonical quiescence before parent ownership wake**

In finishDisposal:

- retain all existing descendant, idle, flush, observer-capture, and handle-disposal steps;
- if any canonical cleanup failure exists, do not call permit.release;
- otherwise await release with startup-failed when announced is false and quiescent when announced is true;
- convert release failure into ACTIVATION_TEARDOWN_FAILED;
- delete the Activation;
- only then notify settlement and release ownership.

Use:

~~~ts
if (
  activation.admissionPermit !== undefined
  && failures.length === 0
) {
  try {
    await activation.admissionPermit.release(
      activation.announced
        ? 'quiescent'
        : 'startup-failed',
    )
  } catch (error: unknown) {
    failures.push(new SubagentError(
      'subagent admission permit release failed: '
        + errorChain(error),
      'ACTIVATION_TEARDOWN_FAILED',
      { cause: error },
    ))
  }
}
~~~

Do not release after releaseOwnership. Descendant permit completion must precede the ownership wake that can let an ancestor settle.

- [ ] **Step 10: Refresh the tracked candidate patch**

Run git diff --check in the exact-source development worktree. Inspect the complete three-file diff and use apply_patch to replace the tracked slim patch with that exact diff.

Verify only the approved official files appear:

~~~bash
git apply --numstat patches/dsh-subagent-admission-seam-slim.patch
~~~

Expected: exactly continuation.ts, index.ts, and types.ts.

- [ ] **Step 11: Run complete stock, reference, and slim official verification**

Run:

~~~bash
pnpm exec tsx scripts/verify-seam-patch.mts --expect-unpatched-failure
pnpm exec tsx scripts/verify-seam-patch.mts --patch reference
pnpm exec tsx scripts/verify-seam-patch.mts --patch slim
~~~

Expected:

- stock RED identifies the missing protocol surface;
- reference full GREEN remains recoverable;
- slim full GREEN runs the complete official subagent tests and all 18 required admission behaviors;
- slim output status is pass, not focused-pass.

- [ ] **Step 12: Enforce all slim metrics**

Run:

~~~bash
pnpm exec tsx scripts/check-seam-patch-size.mts \
  --patch slim \
  --enforce-slim
~~~

Expected:

- no more than 3 official files;
- no more than 313 total changed lines;
- no more than 140 changed continuation.ts lines;
- no more than 455 serialized patch lines;
- slimQualified is true.

If semantics pass but a metric fails, refactor the official diff without deleting tests or failure handling. Do not rename the result slim until this command passes.

- [ ] **Step 13: Remove the temporary worktree safely**

Before removal, confirm:

- its absolute path is exactly the path declared in Task 4;
- HEAD is the pinned commit;
- its complete Git diff is byte-identical to the tracked slim patch when applied to a clean pinned checkout.

Then remove only that exact worktree through git worktree remove --force. Do not use a recursive delete against a variable or broad cache directory.

- [ ] **Step 14: Commit the complete candidate**

Run:

~~~bash
git add patches/dsh-subagent-admission-seam-slim.patch
git commit -m "feat: complete slim lifecycle admission candidate"
~~~

---

### Task 6: Run the external plugin, conformance, and packed-install matrix on either patch

**Interfaces**

- Consumes: shared patch catalog, complete slim candidate, external policy bridge, exact-source conformance harness, and packed plugin proof.
- Produces: explicit reference/slim selection in every Strict harness and candidate evidence that cannot be confused with the current canonical baseline.

**Files**

- Modify: scripts/run-strict-conformance.mts
- Modify: scripts/packed-install.mts
- Modify: scripts/release-evidence.mts
- Modify: tests/packed-install-command.spec.ts

- [ ] **Step 1: Add failing selection tests**

Extend tests/packed-install-command.spec.ts to assert:

- PackedInstallOptions accepts strictPatch: reference or slim;
- invalid names are rejected by parseSeamPatchName;
- the default imported from seam-patch-tooling.ts remains reference before promotion.

Run:

~~~bash
pnpm exec vitest run \
  tests/seam-patch-tooling.spec.ts \
  tests/packed-install-command.spec.ts
~~~

Expected: FAIL until packed-install consumes the shared selection.

- [ ] **Step 2: Add explicit patch selection to Strict conformance**

Extend run-strict-conformance.mts:

~~~text
run-strict-conformance.mts [--patch reference|slim] [--output path]
~~~

Resolve the selected path through seamPatch. Keep the preflight and apply checks unchanged. Add these report fields:

~~~ts
patchName: 'reference' | 'slim'
patchSha256: string
~~~

The default remains DEFAULT_SEAM_PATCH, which is still reference in this task.

- [ ] **Step 3: Add explicit patch selection to packed install**

Extend PackedInstallOptions:

~~~ts
readonly strictPatch?: SeamPatchName
~~~

Extend the CLI:

~~~text
--strict-patch reference|slim
~~~

Pass the selected definition into runStrictProof. Add patchName and patchSha256 to the Strict section of PackedInstallReport. Audit-only runs remain independent and do not need a patch.

- [ ] **Step 4: Remove release-evidence hard-coding**

Change currentPatchHash to resolve DEFAULT_SEAM_PATCH through seamPatch. Do not flip the default yet. Keep baseline hash equality blocking. This makes promotion a one-line default change plus a baseline identity update rather than three unrelated path edits.

- [ ] **Step 5: Run full local plugin tests**

Run:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
~~~

Expected: PASS. This proves the external kernel and GUI code still build; it does not yet prove packed Strict.

- [ ] **Step 6: Run candidate Strict conformance**

Run:

~~~bash
pnpm exec tsx scripts/run-strict-conformance.mts \
  --patch slim
~~~

Expected:

- every REQUIRED_RESULT_IDS row is pass;
- the report names slim and its exact SHA-256;
- stock npm rc.6 remains Audit and non-enforcing;
- no model or external API call occurs.

- [ ] **Step 7: Run candidate packed-install Strict**

Run:

~~~bash
pnpm exec tsx scripts/packed-install.mts \
  --strict-patch slim
~~~

Expected:

- real plugin tarball installs into the isolated profile;
- stock Audit remains non-enforcing;
- exact-source slim Strict enforces the global limit before the seventh provider start;
- the report records the slim patch identity;
- this is local packed evidence, not publication or production deployment.

- [ ] **Step 8: Re-run reference recovery**

Run:

~~~bash
pnpm exec tsx scripts/run-strict-conformance.mts \
  --patch reference
~~~

Expected: PASS through the migration bridge. The reference artifact remains recoverable until promotion review.

- [ ] **Step 9: Commit dual-harness support**

Run:

~~~bash
git add \
  scripts/run-strict-conformance.mts \
  scripts/packed-install.mts \
  scripts/release-evidence.mts \
  tests/packed-install-command.spec.ts
git commit -m "test: qualify both admission seam artifacts"
~~~

---

### Task 7: Write the official-facing package without publishing it

**Interfaces**

- Consumes: approved design, measured slim qualification, exact-source evidence, Discussion #131 reproduction, and dsh-turn-budget precedent.
- Produces: a proposed Agent Note, a concise Discussion draft, and public docs that distinguish complementarity, candidate evidence, and the zero-patch product gate.

**Files**

- Create: docs/upstream-agent-note.md
- Create: docs/discussion-131-draft.md
- Modify: README.md
- Modify: README.zh-CN.md
- Modify: packages/dsh-subagent-admission/README.md
- Modify: packages/dsh-subagent-admission/README.zh-CN.md
- Modify: docs/upstream-seam.md
- Modify: docs/compatibility.md
- Modify: compatibility/ecosystem-audit.md
- Modify: tests/docs.spec.ts

- [ ] **Step 1: Write failing documentation assertions**

Add tests requiring:

- both new files exist;
- upstream-agent-note.md begins with Status: proposed;
- the note contains Service Definition, Provider, Consumer, acquire, bindChild, startup-failed, quiescent, cancellation, tombstone, zero-patch Strict, and the exact source commit;
- discussion-131-draft.md names the work independent and experimental;
- it states 56 requested, 4 admitted, 5 reachable denied before provider execution, and 47 descendants suppressed;
- it names dsh-turn-budget as complementary;
- it asks exactly one question;
- it contains no merge request, job request, maintainer tag, or claim of adoption;
- README documents candidate versus canonical status.

Run:

~~~bash
pnpm exec vitest run tests/docs.spec.ts
~~~

Expected: FAIL because the two documents do not exist.

- [ ] **Step 2: Write the proposed Agent Note**

Use these exact sections:

~~~text
Status: proposed

# Optional lifecycle-owned subagent admission

## Problem
## Alternatives considered
## Decision
## Protocol
## Lifecycle boundaries
## Cancellation and failure semantics
## Testing
## Consequences
## Deferred work
~~~

The note must:

- define SubagentRuntime as Service Definition and Consumer, with an external plugin as Provider;
- ask for one optional documented extension point, not an upstream quota product;
- show the exact protocol types;
- include the one-shot, fresh continuable, cold-resume, resident follow-up, and descendant teardown matrix;
- explain why events, a Cordis waterfall, and registerContinuableSetup are insufficient;
- explain the permanent tombstone and no hot replacement;
- state that patch integration is non-trivial even though the protocol is narrow;
- exclude GUI, hiring, marketing, default quotas, ledger details, and employment language.

- [ ] **Step 3: Write the Discussion draft**

Use this evidence-first body, with links pointing to the public repository documents but do not post it:

~~~markdown
I built an independent lifecycle-admission experiment against DeepSeek Harness commit 47f9438 for the recursive subagent failure shape discussed here. In a bounded, no-model 56-child reproduction, stock Audit allowed all 56 provider starts while the Strict reference policy admitted 4 for one root, denied 5 reachable excess branches before provider execution, and suppressed their 47 descendants.

This is complementary to dsh-turn-budget, which already provides an immediately installable per-turn circuit breaker through public hooks. The remaining experiment is narrower: one atomic decision shared by direct ctx.subagents callers, tools, plugins, and providers, with capacity retained through the official child lifecycle.

The proposed official surface contains no limits, ledger, root resolver, telemetry, or UI. It is a versioned policy registration whose permit is acquired before provider or Agent materialisation, bound after publication, and released after canonical quiescence. The repository includes a pinned RED/GREEN lifecycle fixture, an exact-target slim patch, and the proposed Agent Note.

Would this optional lifecycle-owned admission registration on ctx.subagents fit as a documented extension point?
~~~

Add Markdown links to:

- https://github.com/yha9806/dsh-subagent-admission
- https://github.com/yha9806/dsh-subagent-admission/blob/main/docs/reproduction.md
- https://github.com/yha9806/dsh-subagent-admission/blob/main/docs/upstream-agent-note.md
- https://github.com/Nunchakus888/dsh-turn-budget

Keep the final body between 150 and 180 English words after Markdown link destinations are excluded. The question is the only interrogative sentence.

- [ ] **Step 4: Update upstream and compatibility documents**

Before promotion, state two rows:

1. reference: current canonical, verified, recoverable;
2. slim: qualified candidate, measured within all approved limits, not yet the baseline identity.

Do not insert a guessed slim hash or line count. Read the exact hash and metrics from the passing verifier and size report. If exact integers are not needed in prose, link the reproduction commands instead of copying them.

Explicitly state:

- dsh-turn-budget is the immediate per-turn circuit breaker;
- this project is experimental shared lifecycle authority;
- the controls are complementary and composable;
- no maintainer reply or official adoption has been observed;
- draft creation does not authorize posting.

- [ ] **Step 5: Update both root READMEs**

Add a compact Upstream design package section linking the Agent Note, slim candidate, reference patch, qualification command, and Discussion draft. Keep 80 percent kernel and 20 percent native GUI positioning: the GUI is an operator surface, not the product boundary.

- [ ] **Step 6: Run documentation and sync gates**

Run:

~~~bash
pnpm docs:sync
pnpm docs:check
~~~

Expected: PASS and package README copies are byte-identical to the root documents.

- [ ] **Step 7: Commit the unpublished official-facing package**

Run:

~~~bash
git add \
  docs/upstream-agent-note.md \
  docs/discussion-131-draft.md \
  README.md \
  README.zh-CN.md \
  packages/dsh-subagent-admission/README.md \
  packages/dsh-subagent-admission/README.zh-CN.md \
  docs/upstream-seam.md \
  docs/compatibility.md \
  compatibility/ecosystem-audit.md \
  tests/docs.spec.ts
git commit -m "docs: package slim seam design for upstream review"
~~~

No remote action follows this commit.

---

### Task 8: Promote slim as the local canonical exact-target artifact

**Interfaces**

- Consumes: complete slim official verification, metric pass, external conformance, packed install, documentation package, and current live baseline.
- Produces: one locally committed canonical slim identity with regenerated evidence, while retaining the reference patch file and all external-action boundaries.

**Files**

- Modify: scripts/seam-patch-tooling.ts
- Modify: compatibility/baseline.json
- Modify: docs/upstream-seam.md
- Modify: docs/compatibility.md
- Modify: README.md
- Modify: README.zh-CN.md
- Modify: CHANGELOG.md
- Modify: tests/docs.spec.ts
- Modify after docs sync:
  - packages/dsh-subagent-admission/README.md
  - packages/dsh-subagent-admission/README.zh-CN.md

- [ ] **Step 1: Re-run the promotion preflight from a clean tracked tree**

Run:

~~~bash
git status --short
pnpm baseline:check
pnpm exec tsx scripts/verify-seam-patch.mts --expect-unpatched-failure
pnpm exec tsx scripts/verify-seam-patch.mts --patch reference
pnpm exec tsx scripts/verify-seam-patch.mts --patch slim
pnpm exec tsx scripts/check-seam-patch-size.mts \
  --patch slim \
  --enforce-slim
pnpm exec tsx scripts/run-strict-conformance.mts --patch slim
pnpm exec tsx scripts/packed-install.mts --strict-patch slim
~~~

Expected: clean entry state and every command PASS.

If baseline:check reports official source, npm, or Discussion drift, stop. Preserve the candidate and report the changed fact; do not promote against a stale current claim.

- [ ] **Step 2: Capture the exact candidate identity**

Read patchSha256 from the full slim verifier and independently compare it with:

~~~bash
shasum -a 256 patches/dsh-subagent-admission-seam-slim.patch
~~~

The two lowercase 64-character hashes must match exactly.

- [ ] **Step 3: Flip the shared local default**

Change:

~~~ts
export const DEFAULT_SEAM_PATCH: SeamPatchName = 'slim'
~~~

Do not delete or rename patches/dsh-subagent-admission-seam.patch.

- [ ] **Step 4: Update the blocking baseline identity**

In compatibility/baseline.json, keep source commit, source package version, protocol version, and strictTargets cardinality unchanged. Replace only:

- patchSha256 with the measured slim hash;
- verificationCommand with corepack pnpm tsx scripts/verify-seam-patch.mts --patch slim.

The strict target remains one exact source identity. Do not add a second current target for the reference draft.

- [ ] **Step 5: Update canonical documentation**

Change canonical patch references to patches/dsh-subagent-admission-seam-slim.patch and the exact slim hash. Move the old artifact into an explicitly labelled Recoverable reference row. Include measured qualification values from the passing size report.

Update CHANGELOG.md with:

- acquire(request, signal);
- startup-failed and quiescent release vocabulary;
- cancellation coverage;
- slim size qualification;
- retained reference patch;
- no claim of upstream adoption or package publication.

- [ ] **Step 6: Update default-command assertions**

Update docs tests and evidence checks so:

- default Strict harnesses resolve slim;
- baseline patch hash equals the slim bytes;
- canonical verifier command includes --patch slim;
- reference remains explicitly runnable with --patch reference.

- [ ] **Step 7: Sync docs and run the complete local gate**

Run:

~~~bash
pnpm docs:sync
pnpm baseline:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec tsx scripts/verify-seam-patch.mts --patch slim
pnpm exec tsx scripts/run-strict-conformance.mts
pnpm test:e2e -- tests/packed-install.e2e.ts
pnpm release:evidence
pnpm release:evidence:check
~~~

Expected: every command PASS. Record any platform warnings without converting them into failures or hiding them.

- [ ] **Step 8: Verify release boundaries**

Inspect the generated evidence manifest and assert:

~~~text
modelCalls = 0
apiKeysRequired = false
productionDeployment = false
officialAdoption = false
publication = false
~~~

Also confirm docs/discussion-131-draft.md is a tracked draft only and no GitHub Discussion API or browser posting action occurred.

- [ ] **Step 9: Commit the local promotion**

Run:

~~~bash
git add \
  scripts/seam-patch-tooling.ts \
  compatibility/baseline.json \
  docs/upstream-seam.md \
  docs/compatibility.md \
  README.md \
  README.zh-CN.md \
  packages/dsh-subagent-admission/README.md \
  packages/dsh-subagent-admission/README.zh-CN.md \
  CHANGELOG.md \
  tests/docs.spec.ts
git commit -m "feat: promote slim admission seam candidate"
~~~

- [ ] **Step 10: Final local handoff audit**

Run:

~~~bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
~~~

Expected:

- worktree is clean;
- local commits are listed ahead of origin/main;
- no push has occurred;
- no patch whitespace errors are reported.

Report separately:

1. implementation and local verification;
2. current remote publication state;
3. Discussion draft state;
4. maintainer response state;
5. the remaining zero-patch official-extension gate.

Do not collapse those five outcomes into one completion claim.
