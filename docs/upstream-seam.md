# Experimental DSH shared lifecycle admission seam

This repository proposes one optional, versioned ownership seam in the official
`@deepseek-ai/dsh-subagent` runtime. It lets one external policy make an atomic
decision shared by built-in tools, plugins, providers, SDK callers, and direct
runtime calls before a new child or cold activation may materialize. Provider
execution, Agent construction, continuation routing, and teardown remain under
the official runtime's control.

The proposal is deliberately narrower than an admission-control product. The
official patch contains no limits, queue, durable ledger, root resolver,
telemetry, or GUI. Those remain external policy concerns. Existing plugins may
keep their own product-level limits and UIs; normal calls through the shared
runtime receive Host admission without importing another tool-specific API.

“Narrow contract” does not mean trivial integration. The current exact-target
patch is a reference and conformance vehicle, not a claim that DSH needs only a
few lines of plumbing or that users should maintain this fork shape forever.

## Verified target

| Fact | Canonical baseline (slim) | Recoverable reference |
| --- | --- | --- |
| Official repository | `https://github.com/deepseek-ai/deepseek-harness.git` | `https://github.com/deepseek-ai/deepseek-harness.git` |
| Source commit | `47f943859bef60e4160492346772ded9b24f765a` | `47f943859bef60e4160492346772ded9b24f765a` |
| Source package | `@deepseek-ai/dsh-subagent@0.1.0-rc.5` | `@deepseek-ai/dsh-subagent@0.1.0-rc.5` |
| Patch file | `patches/dsh-subagent-admission-seam-slim.patch` | `patches/dsh-subagent-admission-seam.patch` |
| Patch SHA-256 | `b29860806eb446dc4df1789565c26192b808d638cf404b237c447df10f75c215` | `1340a9ffabde8310f68a7d66c4dacecda5dba263dd51666740801f5ec2c69135` |
| Protocol | `1` | `1` |
| Status | Canonical baseline (promoted) | Recoverable reference artifact |
| Verification | `corepack pnpm tsx scripts/verify-seam-patch.mts --patch slim` | `corepack pnpm tsx scripts/verify-seam-patch.mts --patch reference` |

The source and npm `next` identities are intentionally separate in
`compatibility/baseline.json`; a later source or package version is not silently
treated as supported.

## Public contract

The patch adds an explicit `SubagentRuntime.admissionProtocolVersion === 1` and
one effect-scoped registration method:

```ts
runtime.registerAdmissionPolicy(policy)
```

The policy receives frozen, detached metadata only:

- request ID;
- operation: `new-one-shot`, `new-continuable`, or `cold-resume`;
- provider name;
- durable parent session ID;
- reserved or existing child session ID when known.

It receives no `Agent`, provider object, prompt, result, handle, root assertion,
or disposal capability. An accepted request returns a permit with only two
edges: `bindChild(...)` after official publication and `release(...)` after
official cleanup.

Only one protocol-v1 policy may be registered. Duplicate registration fails
with `DUPLICATE_ADMISSION_POLICY`; an unsupported explicit protocol fails with
`UNSUPPORTED_ADMISSION_PROTOCOL`. Unregistration synchronously tombstones new
access with `ADMISSION_CLOSED` but does not invalidate permits already owned by
runs or Activations. The tombstone is process-lifetime: restoring admission
requires a fresh runtime, so unloading enforcement can never degrade silently
to the stock bypass path.

## Centralized lifecycle points

The seam is placed in the shared runtime rather than in tools or individual
providers:

1. One-shot requests finish official provider/capability/request validation,
   then acquire admission before `provider.start()`.
2. Continuable creation reserves its stable child ID and finishes pure
   validation, then acquires admission before `prepareContinuable()` or Agent
   materialization.
3. Cold resume validates persisted lineage and descriptor state, then acquires
   active capacity before materialization.
4. Resident follow-up reuses its existing Activation and acquires no new permit.
5. A one-shot permit survives result settlement and releases only after the
   wrapped run's memoized `dispose()` reaches quiescence.
6. A continuable permit lives on the Activation through idle/waiting state and
   owned descendants. Canonical child-first teardown releases a descendant's
   permit before waking its parent owner.

Provider or materialization rejection first completes the existing official
cleanup path and then releases the charged permit with `startup-failed`.
Binding failure likewise disposes the newly published run or Activation before
release. If canonical cleanup itself fails, the permit deliberately remains
held: protocol v1 has no force-release that could assert quiescence without
evidence.

With no policy registered, the one-shot path returns the original provider run
object unchanged. Continuable routing retains the existing official ownership
model; the optional hook contributes no second runtime or queue.

## Patch scope

Both patches modify exactly three official source files:

- `packages/subagent/subagent/src/types.ts` — detached protocol-v1 types;
- `packages/subagent/subagent/src/index.ts` — registration and one-shot seam;
- `packages/subagent/subagent/src/continuation.ts` — fresh/cold Activation
  ownership and quiescent release.

Measured comparison:

| Metric | Canonical baseline (slim) | Recoverable reference | Slim limit |
| --- | ---: | ---: | ---: |
| Official files | 3 | 3 | <= 3 |
| Insertions | 202 | 380 | — |
| Deletions | 23 | 38 | — |
| Changed lines | 225 | 418 | <= 313 |
| `continuation.ts` changed lines | 101 | 187 | <= 140 |
| Serialized patch lines | 448 | 607 | <= 455 |

The protocol concepts are small; lifecycle-correct ownership across fresh start,
cold resume, partial failure, descendant teardown, cancellation, and quiescent
release is not. Public communication must describe this as a non-trivial
experimental integration, not a “tiny hook”.

`tests/upstream/admission-policy.spec.ts` is copied into the official package
only by the verifier. It is not embedded in the source patch.

## Official design question and delivery gate

The [official architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
says that every part of DSH is a plugin, that there is no privileged core to
patch, and that a new capability seam should have a Service Definition,
Provider, and Consumer. This proposal is intended to test one question within
that philosophy:

> Would an optional lifecycle-owned subagent admission capability belong as a
> documented extension point?

The upstream proposal artifacts are:

- [Proposed Agent Note](upstream-agent-note.md) — formal Service Definition, Provider, and Consumer specification;
- [Discussion #131 draft](discussion-131-draft.md) — evidence-first discussion draft.

This effort is complementary to [`dsh-turn-budget`](https://github.com/Nunchakus888/dsh-turn-budget),
which provides an immediately installable per-turn circuit breaker on stock DSH.

The long-term product gate is **zero-patch Strict**. An external policy should
register through a documented official capability without requiring users to
carry this exact source patch. If that cannot be achieved, this repository may
remain useful as conformance research but should not become a permanently
patched product matrix.

The current [official contribution guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
does not accept external pull requests and instead directs community work
toward Discussions, independent plugins, the `dsh-plugin` topic, and technical
write-ups. This repository therefore ships the independent experiment and
concise design note first. It has not submitted a PR, tag, package release, or
official Discussion proposal.

## Reproducible RED/GREEN verification

The verifier resolves only the pinned baseline commit, checks checkout identity
and cleanliness, creates a disposable detached worktree, installs the official
lockfile, builds the official subagent package, and runs its complete test
directory plus the reusable admission fixture.

```bash
# Prove the fixture detects the missing stock surface.
corepack pnpm tsx scripts/verify-seam-patch.mts --expect-unpatched-failure

# Preflight, apply, build, and test the canonical slim baseline patch.
corepack pnpm tsx scripts/verify-seam-patch.mts --patch slim

# Preflight, apply, build, and test the recoverable reference patch.
corepack pnpm tsx scripts/verify-seam-patch.mts --patch reference
```

On 2026-08-14, the patched run passed 11 test files and 266 tests on macOS arm64
with Node `v25.9.0` and pnpm `11.19.0`. The local environment had no `corepack`
binary, so the observed run invoked the same script through `pnpm tsx`; the
recorded command above is the cross-environment canonical form. Platform-package,
workspace-cycle, and ignored-build-script bin warnings were present during the
official lockfile install; they did not fail compilation or tests.

The fixture covers registration and tombstoning, unsupported protocol,
provider-before-policy ordering, one-shot publication/binding, result-before-
dispose, provider and binding rollback, failed-cleanup lease retention,
spawn/fork and foreground/background equivalence, fresh continuable creation,
resident follow-up exclusion, cold resume, materialization rollback, and
descendant-first permit release.

## Compatibility boundary

This patch is verified only for the exact target above. `git apply --check` is a
required gate; fuzzy application to a changed official tree is not a supported
upgrade strategy. A new upstream commit requires a fresh source review, RED run,
patch regeneration, complete GREEN run, and a new patch hash before it can be
added to `strictTargets`.

Stock DSH without this protocol can still run the external package in explicit
Audit mode, but it cannot honestly claim Strict enforcement. Package semver or
method presence alone never selects the protocol.
