# Compatibility and upgrade policy

## Exact identities

Strict compatibility is an attested source identity, not a broad semver claim.
The blocking machine-readable source is
[`compatibility/baseline.json`](../compatibility/baseline.json).

| Surface | Verified value |
| --- | --- |
| Official repository | `https://github.com/deepseek-ai/deepseek-harness.git` |
| Official source commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Source `@deepseek-ai/dsh-subagent` version | `0.1.0-rc.5` |
| npm `@deepseek-ai/dsh` latest/next | `0.1.0-rc.6` / `0.1.0-rc.6` |
| npm `@deepseek-ai/dsh-subagent` latest/next | `0.0.1-rc.1` / `0.1.0-rc.6` |
| Protocol | `1` |
| Canonical seam patch (slim) | `patches/dsh-subagent-admission-seam-slim.patch` (`1a3e351cab75ff22d55b0d2a8cb458cbee2794a769cb2f433e105dd421636073`) |
| Recoverable reference patch | `patches/dsh-subagent-admission-seam.patch` (`1340a9ffabde8310f68a7d66c4dacecda5dba263dd51666740801f5ec2c69135`) |
| Plugin candidate | `dsh-subagent-admission@0.1.0-rc.1` |

The official source package at HEAD and npm `next` are different builds. The
baseline records `source-npm-diverged`; it never invents one floating “current
version”.

## Runtime matrix

| Environment | Requested mode | Result | Enforced |
| --- | --- | --- | --- |
| Stock npm rc.6 | Audit | Audit | No |
| Stock npm rc.6 | Strict | Unavailable: seam absent | No |
| Exact source rc.5 + verified canonical slim patch | Audit | Audit | No |
| Exact source rc.5 + verified canonical slim patch + all bootstrap prerequisites | Strict | Strict | Yes |
| Patched/unpatched unknown source or package | Strict | Unavailable: unsupported build | No |
| Protocol not exactly v1 | Strict | Unavailable: unsupported protocol | No |
| Missing storage, unsafe lineage, live pre-coverage child, or ownership conflict | Strict | Unavailable with exact reason | No |

Audit never registers a policy, even if a seam happens to exist. Strict never
silently becomes Audit.

## Delivery maturity and product gate

- Stock Audit is installable observability only. It cannot prevent a start and
  is not a #131 painkiller.
- Patched Strict is a verified reference implementation and conformance system
  for one exact source identity. The canonical slim seam patch is 230 changed lines
  across three official files (455 serialized patch lines, including 106 changed
  lines in `continuation.ts`), with the 607-line reference patch retained as a
  recoverable baseline artifact.
- A documented official capability that supports **zero-patch Strict** is the
  productization gate. Permanently maintaining a private patched-upstream
  matrix is not the intended sustainable product.
- The source repository is public. npm publication, external users, production
  deployment, maintainer response, and DeepSeek adoption have not been shown.

For a stock-DSH, immediately installable per-turn safety circuit breaker,
[`dsh-turn-budget`](https://github.com/Nunchakus888/dsh-turn-budget) is the
closest complement. Its step/tool/provider-token budgets and this project's
cross-caller lifecycle admission solve different layers.

## Strict activation prerequisites

Strict requires every one of the following:

1. `admissionProtocolVersion === 1`;
2. an actual `registerAdmissionPolicy` function;
3. installed runtime package version matching an entry in `strictTargets`;
4. the source commit, source package version, patch hash, and conformance
   command recorded for that target;
5. storage-domain availability and a successfully opened authoritative ledger;
6. exclusive ownership of the configured single-process guard;
7. readable, acyclic, non-conflicting parent/root lineage;
8. no live subagent activation that predates policy coverage;
9. successful, unique policy registration.

Method-presence duck typing, fuzzy patch application, post-start events, tool
wrapping, provider wrapping, or best-effort bootstrap cannot satisfy this list.

## Reproduction commands

```bash
# Confirm that live official source/npm/#131 identities still match the pin.
pnpm baseline:check

# Prove the test fixture fails against unpatched stock source.
pnpm exec tsx scripts/verify-seam-patch.mts --expect-unpatched-failure

# Preflight/apply/build/test canonical slim baseline patch in a disposable worktree.
pnpm exec tsx scripts/verify-seam-patch.mts --patch slim

# Preflight/apply/build/test recoverable reference patch in a disposable worktree.
pnpm exec tsx scripts/verify-seam-patch.mts --patch reference

# Compose packed stock Audit and exact-target Strict (defaults to canonical slim).
pnpm exec tsx scripts/run-strict-conformance.mts

# Exercise the real package install and native Web integration.
pnpm test:e2e -- tests/packed-install.e2e.ts
```

The canonical `corepack pnpm ...` command remains recorded in the baseline for
portable automation. A local machine without `corepack` may invoke the same
script through its pinned `pnpm` installation; that substitution must be
reported rather than hidden.

## Upgrade gate

A new upstream commit or package is unsupported until all steps complete:

1. refresh the read-only candidate identity without overwriting the blocking
   baseline;
2. review every changed lifecycle point in one-shot start, continuable start,
   resident follow-up, cold resume, drain, and cleanup;
3. regenerate the patch against the exact source identity;
4. run `git apply --check` with no fuzz;
5. prove the reusable fixture is RED on the unpatched target;
6. apply the patch and run the complete official subagent tests plus protocol
   fixture;
7. run stock Audit and patched Strict conformance through the packed plugin;
8. run crash, package, client, and native GUI gates;
9. record a new patch hash and exact target in `strictTargets`;
10. review and commit the baseline change separately from observed drift.

The scheduled `Upstream drift` workflow is read-only. It uploads a candidate
artifact and fails informatively; it does not open issues, edit the baseline,
push commits, or make compatibility claims.

## Platform evidence boundary

The repository configures:

- Linux with Node 22.19.0 and Node 24 for full gates;
- macOS and Windows with Node 24 for ownership, build, client, and packed Audit
  smoke checks;
- Linux Node 24 native GUI capture as an uploaded artifact.

Workflow configuration is not evidence that GitHub Actions has run. The public
badge and linked workflow runs are remote evidence; local macOS results prove
only the commands and environment recorded in the generated manifest. A green
run, npm publication, DeepSeek adoption, maintainer response, and production
deployment are independent release gates.

## Ecosystem compatibility

The policy is intentionally provider- and caller-neutral at the official
runtime seam. Existing plugins do not need to import the reference policy:
their normal `ctx.subagents` calls are governed automatically when Host Strict
is active.

This does not make other plugins dependencies or imply endorsement. Their own
tool-local limits, team/member rules, dependency gates, scheduling, or GUIs
remain independent. `dsh-turn-budget` remains the immediately deployable
per-turn circuit breaker; lifecycle admission remains an experimental
exact-target capability. The current direct-source boundary analysis is
maintained in
[`compatibility/ecosystem-audit.md`](../compatibility/ecosystem-audit.md).
