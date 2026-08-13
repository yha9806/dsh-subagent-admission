# dsh-subagent-admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a lifecycle-safe, fail-fast subagent admission-control plugin for DeepSeek Harness, with an external policy kernel, a minimal versioned upstream seam, durable root quotas, a read-only native Admission Control view, and release-grade evidence.

**Architecture:** A single installable dual-face package lives under `packages/dsh-subagent-admission`: its Host face owns compatibility, durable lineage/accounting, active permits, telemetry, and Typert Snapshot Remote; its Client face mounts that generated Remote and registers one `conversation.view`. Strict mode is available only with protocol-v1 admission support in a pinned DSH source build; stock DSH runs explicitly configured Audit mode and never claims enforcement. The GitHub release artifact is a prebuilt `.tgz`, so users do not execute a git dependency `prepare` script.

**Tech Stack:** TypeScript 6.0.3, Node.js 22.19+/24, pnpm 11.7.0, tsdown 0.22.2, Vitest 4.1.8, fast-check 4.8.0, Testing Library React 16.3.2, Playwright 1.62.1, Zod 4.4.3, Schemastery 3.18.1, React 18.2, DeepSeek Harness npm rc.6 for stock/Audit compatibility, a pinned official source SHA plus the reference patch for Strict conformance, Typert Remote, DSH storage-domain with JSON and SQLite backends.

## Global Constraints

- Preserve the frozen design in `docs/superpowers/specs/2026-08-13-dsh-subagent-admission-design.md`; semantic changes return to design review.
- Default quotas are exactly: global active `6`, per-root active `4`, per-root admitted total `24`, and per-parent admitted children `8`.
- Admission is fail-fast and queue-free; a short mutation-serialization chain is not a capacity wait queue.
- Denial occurs before provider work, child materialization, child artifacts, model calls, and durable writes.
- A newly accepted child performs exactly one plugin-authoritative durable ledger write; cumulative charges are never refunded after linearization.
- Cold resume consumes active capacity only; resident continuable follow-up consumes no new quota or permit.
- Active capacity releases only after canonical quiescent cleanup; duplicate release is idempotent.
- Root identity comes from durable all-parent traversal; callers and the official seam never supply a trusted root.
- Strict is single-host and single-process, has no process isolation, and fails closed on missing protocol, unsafe bootstrap, ambiguous lineage, ownership conflict, or state I/O failure.
- Stock DSH is Audit-only. Audit telemetry is non-authoritative and must not imply enforcement.
- GUI and RPC are read-only and may expose operational IDs but never prompts, messages, model output, tool arguments, environment values, credentials, or raw sensitive stacks.
- The history ring holds exactly 200 recent events, reports dropped count, and resets on process epoch change.
- Runtime support is proven against exact identities. Package semver alone is never evidence of Strict compatibility.
- Current planning baseline on 2026-08-13 is official HEAD `47f943859bef60e4160492346772ded9b24f765a`, source package family `0.1.0-rc.5`, npm `@deepseek-ai/dsh` `0.1.0-rc.6`, npm `@deepseek-ai/dsh-subagent` `latest=0.0.1-rc.1`, `next=0.1.0-rc.6`, and Discussion #131 open with five votes, two community comments, and no maintainer reply observed; Task 1 must refresh and record drift before code depends on it.
- CI covers Linux on Node 22.19 and 24, with macOS and Windows smoke jobs.
- No npm publication, GitHub release, push, profile mutation, Discussion reply, curated-list PR, LinkedIn post, or job application occurs in this plan.
- The existing commit uses an auto-generated local Git identity. Before the first implementation commit, obtain the user's approved GitHub/noreply email and set repository-local `user.name`/`user.email`; do not amend existing commits without separate approval.

---

## File Structure

The repository is a private workspace; only the nested package is packed and distributed.

```text
.
├── .gitignore                           # excludes dependencies, builds, caches, and generated evidence
├── package.json                         # private workspace scripts and exact dev toolchain
├── pnpm-lock.yaml                       # frozen dependency graph
├── pnpm-workspace.yaml                  # packages/* only
├── tsconfig.base.json                   # shared strict TypeScript options
├── tsconfig.host.json                   # Host aggregate; Typert discovery root
├── tsconfig.client.json                 # Client aggregate, built after Host Remote generation
├── vitest.config.ts                     # unit/component suite
├── vitest.e2e.config.ts                 # process, packed-install, and patched-runtime fixtures
├── build/
│   ├── client-bundle.ts                 # standalone DSH closure-factory client bundle config
│   └── web-platform.ts                  # exact shared browser module identities
├── compatibility/
│   ├── baseline.json                    # refreshed source/npm identities and support labels
│   └── ecosystem-audit.md              # closest official/community/Pi precedents and residual demand
├── .github/workflows/
│   ├── ci.yml                           # blocking exact package/platform matrix
│   └── upstream-drift.yml               # non-blocking official HEAD/npm drift signal
├── packages/dsh-subagent-admission/
│   ├── package.json                     # installable bundle and dual-face manifest
│   ├── cordis.patch.yml                 # one Host/Client plugin row
│   ├── README.md                        # packed English install/mode truth
│   ├── README.zh-CN.md                  # packed Chinese install/mode truth
│   ├── LICENSE                          # packed MIT license copy
│   ├── tsconfig.host.json               # Host/public declarations
│   ├── tsconfig.client.json             # browser declarations
│   ├── tsdown.config.ts                 # Host+Typert and Client build faces
│   ├── src/
│   │   ├── index.ts                     # Host plugin entry and Config export
│   │   ├── invariant.ts                 # package/runtime invariant companion
│   │   ├── types.ts                     # Client-safe Remote/snapshot vocabulary
│   │   ├── host/
│   │   │   ├── config.ts                # exact quota/mode/path validation
│   │   │   ├── errors.ts                # stable typed denial vocabulary
│   │   │   ├── seam-v1.ts               # local structural mirror of official protocol v1
│   │   │   ├── state-model.ts            # pure deterministic transition model
│   │   │   ├── root-resolver.ts          # durable ancestry and immutable bindings
│   │   │   ├── ledger-spec.ts            # storage-domain schema and RootLedgerRow
│   │   │   ├── ledger.ts                 # exactly-one-write cumulative reservation
│   │   │   ├── process-guard.ts          # exclusive cooperative owner guard
│   │   │   ├── leases.ts                 # process-local active lease registry
│   │   │   ├── authority.ts              # canonical check/reserve/permit/release authority
│   │   │   ├── telemetry.ts              # non-authoritative ring and snapshot hub
│   │   │   ├── compatibility.ts          # exact package/protocol/bootstrap mode probe
│   │   │   └── service.ts                # Cordis service, Audit observer, Typert methods
│   │   └── client/
│   │       ├── index.ts                  # Remote mount, locale, conversation.view registration
│   │       ├── controller.ts             # epoch/revision full-snapshot long-poll controller
│   │       ├── AdmissionControlView.tsx   # read-only native view
│   │       ├── styles.ts                  # plugin-owned style injection and cleanup
│   │       └── locales.ts                 # English/Chinese copy
│   └── tests/
│       ├── manifest.spec.ts
│       ├── config.spec.ts
│       ├── state-model.spec.ts
│       ├── state-model.property.spec.ts
│       ├── root-resolver.spec.ts
│       ├── ledger.contract.ts
│       ├── ledger-json.spec.ts
│       ├── ledger-sqlite.spec.ts
│       ├── process-guard.spec.ts
│       ├── authority.spec.ts
│       ├── telemetry.spec.ts
│       ├── service.spec.ts
│       ├── client-controller.client.spec.ts
│       ├── admission-view.client.spec.tsx
│       └── client-bundle.client.spec.ts
├── patches/
│   └── dsh-subagent-admission-seam.patch # minimal official source patch
├── scripts/
│   ├── refresh-baseline.mts              # source/npm drift audit
│   ├── verify-seam-patch.mts             # clone exact SHA, apply, build, test
│   ├── run-strict-conformance.mts         # patched direct-service matrix
│   ├── packed-install.mts                 # temp profile and tarball proof
│   ├── crash-fixture.mts                  # post-ledger-commit kill/restart driver
│   ├── benchmark.mts                      # raw reproducible timing output
│   ├── reproduce-131.mts                  # safe scripted 56-child workload
│   ├── sync-package-docs.mts              # verifies/copies packed README and license files
│   └── release-evidence.mts               # aggregate immutable evidence manifest
├── tests/
│   ├── benchmark.spec.ts                  # benchmark schema and deterministic summaries
│   ├── docs.spec.ts                       # compatibility and claim-truth checks
│   ├── upstream/
│   │   └── admission-policy.spec.ts         # copied into pinned official checkout for red/green seam tests
│   ├── conformance/
│   │   ├── matrix.ts
│   │   ├── fake-provider.ts
│   │   ├── lifecycle-barriers.ts
│   │   ├── strict-runtime.e2e.ts
│   │   └── stock-audit.e2e.ts
│   ├── crash/
│   │   ├── child.mts
│   │   └── restart.e2e.ts
│   └── packed-install.e2e.ts
├── docs/
│   ├── architecture.md
│   ├── assets/
│   │   └── admission-control.png          # packed-install native GUI capture
│   ├── compatibility.md
│   ├── upstream-seam.md
│   └── reproduction.md
├── evidence/.gitkeep                    # generated evidence stays uncommitted until release gate
├── README.md
├── README.zh-CN.md
├── SECURITY.md
├── CHANGELOG.md
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

The Host, Client, official patch, and evidence scripts are separate units. The Client depends only on generated Remote contracts and full snapshots; it never imports Host authority code. The reference patch depends on no plugin implementation module and exposes only protocol-v1 detached contracts.

---

### Task 1: Exact baseline and standalone dual-face package skeleton

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.host.json`
- Create: `tsconfig.client.json`
- Create: `vitest.config.ts`
- Create: `vitest.e2e.config.ts`
- Create: `build/web-platform.ts`
- Create: `build/client-bundle.ts`
- Create: `compatibility/baseline.json`
- Create: `compatibility/ecosystem-audit.md`
- Create: `scripts/refresh-baseline.mts`
- Create: `packages/dsh-subagent-admission/package.json`
- Create: `packages/dsh-subagent-admission/cordis.patch.yml`
- Create: `packages/dsh-subagent-admission/tsconfig.host.json`
- Create: `packages/dsh-subagent-admission/tsconfig.client.json`
- Create: `packages/dsh-subagent-admission/tsdown.config.ts`
- Create: `packages/dsh-subagent-admission/src/index.ts`
- Create: `packages/dsh-subagent-admission/src/invariant.ts`
- Create: `packages/dsh-subagent-admission/src/types.ts`
- Create: `packages/dsh-subagent-admission/src/client/index.ts`
- Test: `packages/dsh-subagent-admission/tests/manifest.spec.ts`
- Test: `packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts`

**Interfaces:**
- Consumes: official npm metadata, official repository HEAD/package version, Discussion #131, current DSH plugin/topic results, and direct Pi source/docs.
- Produces: package name `dsh-subagent-admission`; build commands `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm pack:plugin`; exact `CompatibilityBaselineV1`; Host export `.`, Client export `./client`, and public wire vocabulary `./types`. Typert exports remain absent until a real Remote service exists.

- [ ] **Step 1: Refresh the novelty-and-coverage kill gate before scaffolding**

Use current primary/direct sources to record in `compatibility/ecosystem-audit.md`:

- official DSH source locations for one-shot, continuable, cold-resume, registration, and cleanup seams at the exact HEAD;
- Discussion #131 state and maintainer/community responses;
- exact npm/GitHub identities for packages or repositories matching `dsh-plugin`, subagent limits, admission control, concurrency, or continuable lifecycle;
- the closest Pi subagent/concurrency mechanism at an exact source commit;
- three separate judgments: what is already covered, what remains unsolved for DSH, and what this project can still differentiate on.

Expected current judgment to verify, not assume: stock DSH exposes no complete pre-materialization admission seam; the observed `dsh-web-ui` project is a GUI/skin contribution rather than a lifecycle admission kernel; Pi is an architectural comparison rather than a drop-in DSH lifecycle solution. If an official implementation or close plugin now covers the kernel and conformance claim, stop before creating package files and present Go, Reframe, or Kill again.

- [ ] **Step 2: Write the manifest and baseline tests first**

```ts
it('declares one installable dual-face DSH bundle', () => {
  const manifest = readJson('packages/dsh-subagent-admission/package.json')
  expect(manifest.name).toBe('dsh-subagent-admission')
  expect(manifest.engines).toEqual({ node: '^22.19.0 || >=24.0.0' })
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.dsh.client).toEqual({
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
  })
  expect(manifest.exports).toHaveProperty('./client')
  expect(manifest.exports).toHaveProperty('./types')
})

it('records source/npm divergence instead of inventing one current version', () => {
  const baseline = readJson('compatibility/baseline.json')
  expect(baseline.schemaVersion).toBe(1)
  expect(baseline.source.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(baseline.source.packageVersion).toBeTruthy()
  expect(baseline.npm['@deepseek-ai/dsh-subagent'].next).toBeTruthy()
  expect(baseline.discussion131.url).toBe('https://github.com/deepseek-ai/deepseek-harness/discussions/131')
  expect(baseline.discussion131.state).toMatch(/^(open|closed)$/)
  expect(baseline.discussion131.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(baseline.strictTargets).toEqual([])
  expect(['aligned', 'source-npm-diverged']).toContain(baseline.status)
})
```

`CompatibilityBaselineV1.strictTargets` starts as an empty array. A target row has exact `sourceCommit`, `sourcePackageVersion`, `protocolVersion`, `patchSha256`, and `verificationCommand` fields; it is added only after Task 9 applies and verifies the reference patch. Observed source/npm metadata and supported Strict targets are separate fields, so a refresh cannot silently promote a new upstream build.

- [ ] **Step 3: Run the tests to verify the empty repository fails**

Run: `corepack pnpm dlx vitest@4.1.8 run packages/dsh-subagent-admission/tests/manifest.spec.ts`

Expected: FAIL because the workspace/package manifests and baseline do not exist.

- [ ] **Step 4: Add the private workspace and exact toolchain**

Use this root shape and generate the lockfile with `corepack pnpm install`:

```json
{
  "name": "dsh-subagent-admission-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "scripts": {
    "baseline:check": "tsx scripts/refresh-baseline.mts --check",
    "baseline:write": "tsx scripts/refresh-baseline.mts --write",
    "build:host": "tsc -b tsconfig.host.json && pnpm --dir packages/dsh-subagent-admission exec tsdown --env.DSH_BUILD_FACE host",
    "build:client": "tsc -b tsconfig.client.json && pnpm --dir packages/dsh-subagent-admission exec tsdown --env.DSH_BUILD_FACE client",
    "build": "pnpm build:host && pnpm build:client",
    "lint": "oxlint .",
    "typecheck": "pnpm build:host && tsc -b tsconfig.client.json --pretty false",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "pack:plugin": "pnpm build && pnpm --dir packages/dsh-subagent-admission pack --pack-destination ../../dist"
  },
  "devDependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.6",
    "@deepseek-ai/dsh-typert-generator": "0.1.0-rc.6",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.4",
    "@types/node": "22.20.0",
    "@types/react": "18.3.1",
    "@types/react-dom": "18.3.0",
    "fast-check": "4.8.0",
    "jsdom": "29.1.1",
    "oxlint": "1.78.0",
    "playwright": "1.62.1",
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "tsdown": "0.22.2",
    "tsx": "4.22.4",
    "typescript": "6.0.3",
    "vite-tsconfig-paths": "6.1.1",
    "vitest": "4.1.8",
    "zod": "4.4.3"
  }
}
```

`.gitignore` excludes `node_modules/`, `lib/`, `dist/`, `.cache/`, TypeScript build-info files, and every generated `evidence/*` artifact, then re-includes only `evidence/.gitkeep`. Generated package output is release-only and is never staged by implementation tasks.

`pnpm-workspace.yaml` contains only:

```yaml
packages:
  - packages/*
```

- [ ] **Step 5: Implement the standalone client closure-factory build helper**

`build/web-platform.ts` exports exactly the DSH module-table identities used by this Client:

```ts
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const
```

`build/client-bundle.ts` exports `dshClientBundle(id, entry)`. It emits CJS to `lib/client.js`, keeps the platform modules external, and wraps output with the real loader handoff. Once Task 8 generates `dsh-subagent-admission/remote`, the helper deliberately inlines that self-import and Zod:

```ts
export function dshClientBundle(id: string, entry: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client'],
    noExternal: (specifier: string) =>
      PLATFORM_MODULES.includes(specifier as never)
      || specifier === '@deepseek-ai/dsh-client-runtime/client'
        ? undefined
        : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }
}
```

Add a build-time purity plugin that throws for any runtime `@deepseek-ai/*` import not in the external list. The only non-platform runtime contribution allowed is the generated self import `dsh-subagent-admission/remote`, which is deliberately inlined.

- [ ] **Step 6: Add the package manifest and minimal no-op Host/Client entries**

The package has DSH peers in `>=0.1.0-rc.5 <0.2.0`, exact rc.6 dev dependencies, `@deepseek-ai/cordis` peer `^4.0.1`, React peer `^18.2.0`, and runtime dependencies `@deepseek-ai/schemastery@3.18.1` and `zod@4.4.3`. Its initial `files` allowlist names `lib/index.js`, `lib/invariant.js`, `lib/client.js`, `lib/types/**/*.js`, `lib/types/**/*.d.ts`, and `cordis.patch.yml`; generated Typert artifacts and packed documentation enter only after their producing tasks pass. The patch inserts exactly one row:

```yaml
- insert:
    - id: subagent-admission
      name: dsh-subagent-admission
      config:
        mode: audit
        globalActive: 6
        perRootActive: 4
        perRootAdmittedTotal: 24
        perParentChildren: 8
        ownershipPath: !!js dshHomePath('sessions/.dsh-subagent-admission-owner')
```

The initial Host and Client `apply` functions do nothing. They exist only to prove packaging; functional behavior arrives in later tasks.

- [ ] **Step 7: Implement and run the refresh script**

`refresh-baseline.mts` runs `git ls-remote`, reads the official source package version from the exact fetched commit, queries npm dist-tags, and reads Discussion #131 state, votes, comments, maintainer-comment count, and `updatedAt` from the canonical public page's embedded structured data without a token. A missing or changed structured-data shape fails closed instead of guessing from rendered text. It writes stable sorted JSON with an explicit `observedAt`. `--check` ignores only the passage of wall-clock time, compares all source values with `compatibility/baseline.json`, and exits nonzero on drift. Refresh preserves verified `strictTargets` byte-for-byte, but marks them non-current when observed source identity moves; it never promotes a new target. It must produce the current `source-npm-diverged` state rather than converting rc.5 source into rc.6.

Run: `corepack pnpm baseline:write && corepack pnpm baseline:check`

Expected: PASS; the committed baseline contains exact identities and no credentials.

- [ ] **Step 8: Build, run artifact tests, and inspect the tarball**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run packages/dsh-subagent-admission/tests/manifest.spec.ts packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts
corepack pnpm pack:plugin
tar -tzf dist/dsh-subagent-admission-0.1.0-rc.1.tgz
```

Expected: PASS; `lib/index.js`, `lib/client.js`, declaration files, and `cordis.patch.yml` are present, while no Typert artifact is claimed before Task 8. The tarball contains no `src/`, tests, build-info, cache, or repository-only docs. The client artifact calls `window.__ModuleLoader__.load` with ID `dsh-subagent-admission`.

- [ ] **Step 9: Commit the skeleton**

```bash
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json vitest*.ts build compatibility scripts/refresh-baseline.mts packages/dsh-subagent-admission
git commit -m "build: scaffold dsh admission plugin"
```

---

### Task 2: Public contracts, typed failures, and pure state model

**Files:**
- Modify: `packages/dsh-subagent-admission/src/types.ts`
- Create: `packages/dsh-subagent-admission/src/host/config.ts`
- Create: `packages/dsh-subagent-admission/src/host/errors.ts`
- Create: `packages/dsh-subagent-admission/src/host/seam-v1.ts`
- Create: `packages/dsh-subagent-admission/src/host/state-model.ts`
- Test: `packages/dsh-subagent-admission/tests/config.spec.ts`
- Test: `packages/dsh-subagent-admission/tests/state-model.spec.ts`
- Test: `packages/dsh-subagent-admission/tests/state-model.property.spec.ts`

**Interfaces:**
- Consumes: package skeleton and Zod/Schemastery.
- Produces: `AdmissionLimits`, `AdmissionOperation`, `AdmissionMode`, `AdmissionSnapshot`, `SnapshotGetRequest`, `SnapshotWatchRequest`, `AdmissionErrorCode`, `AdmissionDenied`, `SubagentAdmissionPolicyV1`, `SubagentAdmissionPermitV1`, `transitionModel(state, command)`.

- [ ] **Step 1: Write config and deterministic violation-order tests**

```ts
it('rejects incoherent limits at the config boundary', () => {
  expect(() => resolveConfig({
    mode: 'strict', globalActive: 3, perRootActive: 4,
    perRootAdmittedTotal: 24, perParentChildren: 8,
    ownershipPath: '/tmp/admission-owner',
  })).toThrow('perRootActive must not exceed globalActive')
})

it('returns permanent cumulative denials before transient active denials', () => {
  const result = transitionModel(state({
    globalActive: 6, rootActive: 4, rootTotal: 24, parentChildren: 8,
  }), command('new-one-shot'))
  expect(result).toEqual(denied('ROOT_TOTAL_LIMIT'))
})
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/config.spec.ts packages/dsh-subagent-admission/tests/state-model.spec.ts`

Expected: FAIL because the contracts/model are absent.

- [ ] **Step 3: Define the exact public wire vocabulary**

Use string unions and readonly plain data only:

```ts
export type AdmissionOperation = 'new-one-shot' | 'new-continuable' | 'cold-resume'
export type AdmissionMode = 'strict' | 'audit' | 'unavailable' | 'draining'

export interface AdmissionLimits {
  readonly globalActive: number
  readonly perRootActive: number
  readonly perRootAdmittedTotal: number
  readonly perParentChildren: number
}

export interface SnapshotWatchRequest {
  readonly sessionId: string
  readonly epoch: string | null
  readonly revision: number
  readonly timeoutMs: number
}
```

`AdmissionSnapshot` contains `schemaVersion: 1`, epoch/revision/time, requested session/root IDs, mode/reason, limits/usage, leases, 200-event history, and `droppedHistory`. Do not include arbitrary metadata dictionaries that could later leak content.

- [ ] **Step 4: Define protocol-v1 structural types and typed errors**

```ts
export interface SubagentAdmissionRequestV1 {
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly provider: string
  readonly parentSessionId: string
  readonly childSessionId?: string
}

export interface SubagentAdmissionPermitV1 {
  bindChild(binding: {
    readonly childSessionId: string
    readonly localParentSessionId?: string
  }): void
  release(reason: 'completed' | 'aborted' | 'error' | 'startup-failed' | 'disposed'): Promise<void>
}

export interface SubagentAdmissionPolicyV1 {
  readonly protocolVersion: 1
  prepare(request: SubagentAdmissionRequestV1): Promise<SubagentAdmissionPermitV1>
}
```

Define exactly eight error codes from the spec and make `AdmissionDenied` copy/freeze only code, operation, root/parent IDs, observed value, limit, policy epoch, and request ID.

- [ ] **Step 5: Implement the pure model and property tests**

The pure model owns no I/O. `transitionModel` supports new admission, cold resume, resident follow-up, bind, release, unload, restart, and injected ledger failure. Add fast-check properties:

```ts
fc.assert(fc.property(commandSequenceArb, (commands) => {
  const final = runModel(commands)
  expect(final.globalActive).toBeGreaterThanOrEqual(0)
  expect(final.globalActive).toBeLessThanOrEqual(final.limits.globalActive)
  for (const root of final.roots.values()) {
    expect(root.active).toBeLessThanOrEqual(final.limits.perRootActive)
    expect(root.total).toBeLessThanOrEqual(final.limits.perRootAdmittedTotal)
  }
}))
```

Also assert restart preserves cumulative counts and resets active leases; resident follow-up is a no-op; duplicate release never decrements twice.

- [ ] **Step 6: Run and commit**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/config.spec.ts packages/dsh-subagent-admission/tests/state-model.spec.ts packages/dsh-subagent-admission/tests/state-model.property.spec.ts`

Expected: PASS.

```bash
git add packages/dsh-subagent-admission/src/types.ts packages/dsh-subagent-admission/src/host packages/dsh-subagent-admission/tests/config.spec.ts packages/dsh-subagent-admission/tests/state-model*.spec.ts
git commit -m "feat: define admission state model"
```

---

### Task 3: Durable all-parent root resolution and immutable child bindings

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/root-resolver.ts`
- Test: `packages/dsh-subagent-admission/tests/root-resolver.spec.ts`

**Interfaces:**
- Consumes: `SessionId` and `SessionPersistence.inspect`; `ADMISSION_UNAVAILABLE` and `ADMISSION_BINDING_CONFLICT`.
- Produces: `SessionHeaderReader`, `ResolvedLineage`, `DurableRootResolver.resolve(parentSessionId)`, `DurableRootResolver.bindChild(binding)`.

- [ ] **Step 1: Write missing-parent, cycle, ordinary-fork, and binding-conflict tests**

```ts
it('walks ordinary forks and subagents to one stable root', async () => {
  const resolver = resolverFor({
    root: { id: 'root' },
    fork: { id: 'fork', parentSession: 'root' },
    child: { id: 'child', parentSession: 'fork', origin: 'subagent' },
  })
  await expect(resolver.resolve('child')).resolves.toEqual({
    rootSessionId: 'root', lineage: ['child', 'fork', 'root'],
  })
})

it('fails closed on a cycle', async () => {
  const resolver = resolverFor({ a: { id: 'a', parentSession: 'b' }, b: { id: 'b', parentSession: 'a' } })
  await expect(resolver.resolve('a')).rejects.toMatchObject({ code: 'ADMISSION_UNAVAILABLE' })
})
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/root-resolver.spec.ts`

Expected: FAIL because `DurableRootResolver` is missing.

- [ ] **Step 3: Implement durable traversal with immutable memoization**

```ts
export interface SessionHeaderReader {
  inspect(sessionId: string): Promise<{ readonly id: string; readonly parentSession?: string } | undefined>
}

export interface RootResolution {
  resolve(parentSessionId: string): Promise<ResolvedLineage>
  bindChild(input: {
    readonly childSessionId: string
    readonly expectedParentSessionId: string
    readonly expectedRootSessionId: string
    readonly localParentSessionId?: string
  }): void
}
```

Implement `DurableRootResolver` against this interface. `resolve` repeatedly calls `headers.inspect(currentId)`, adds each ID to a visited set, and stops only at a header without `parentSession`; it rejects an absent header, repeated ID, or more than 1,024 ancestors. It memoizes every traversed session to the discovered root only after the complete chain succeeds. `bindChild` rejects any mismatch between `expectedParentSessionId` and `localParentSessionId`, and rejects any attempt to rebind a child to a different root. A remote run ID may be cached for telemetry without pretending it has a durable Session header.

- [ ] **Step 4: Run and commit**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/root-resolver.spec.ts`

Expected: PASS.

```bash
git add packages/dsh-subagent-admission/src/host/root-resolver.ts packages/dsh-subagent-admission/tests/root-resolver.spec.ts
git commit -m "feat: resolve durable admission roots"
```

---

### Task 4: Exactly-one-write root ledger over JSON and SQLite

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/ledger-spec.ts`
- Create: `packages/dsh-subagent-admission/src/host/ledger.ts`
- Create: `packages/dsh-subagent-admission/tests/ledger.contract.ts`
- Create: `packages/dsh-subagent-admission/tests/ledger-json.spec.ts`
- Create: `packages/dsh-subagent-admission/tests/ledger-sqlite.spec.ts`
- Modify: `packages/dsh-subagent-admission/package.json`

**Interfaces:**
- Consumes: `storageDomain.open`, Zod, `AdmissionLimits`, root/parent IDs.
- Produces: `RootLedgerRow`, `RootLedgerStore.open()`, `reserveNew(input, assertActiveCapacity)`, `read(rootId)`, `close()`; instrumentation `LedgerProbe.writes` for operation-budget assertions. The supplied active-capacity assertion is an internal synchronous callback with no I/O, user code, or mutation.

- [ ] **Step 1: Write one reusable ledger contract**

```ts
export function ledgerContract(open: () => Promise<LedgerFixture>): void {
  it('uses one durable write for one accepted child and none for denial', async () => {
    const f = await open()
    for (let admitted = 0; admitted < 8; admitted += 1) {
      await f.ledger.reserveNew(
        { rootSessionId: 'r', parentSessionId: 'p', limits: LIMITS, now: admitted + 1 },
        () => undefined,
      )
    }
    expect(f.probe.writes).toBe(8)
    await expect(f.ledger.reserveNew(
      { rootSessionId: 'r', parentSessionId: 'p', limits: LIMITS, now: 9 },
      () => undefined,
    )).rejects.toMatchObject({ code: 'PARENT_CHILD_LIMIT' })
    expect(f.probe.writes).toBe(8)
  })
}
```

Run the same contract against temporary JSON and SQLite storage-domain stacks. Include concurrent reservations, reopen, corrupted schema, and backend write rejection.

- [ ] **Step 2: Run both contracts and confirm failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/ledger-json.spec.ts packages/dsh-subagent-admission/tests/ledger-sqlite.spec.ts`

Expected: FAIL because the domain and ledger do not exist.

- [ ] **Step 3: Define one-record-per-root schema**

```ts
export interface RootLedgerRow {
  readonly schemaVersion: 1
  readonly rootSessionId: string
  readonly coverageStartedAt: number
  readonly admittedTotal: number
  readonly admittedChildrenByParent: Readonly<Record<string, number>>
  readonly revision: number
}
```

Define domain `subagent_admission`, version `1`, table `roots`. The root total and every parent count live in one row so the accepted operation is one atomic `put`/`update`, not a cross-table pseudo-transaction.

- [ ] **Step 4: Implement serialized read/check/write**

`RootLedgerStore.reserveNew` runs inside one short promise-tail critical section. It reads the current row, checks root total then parent total, synchronously invokes the authority-owned active-capacity assertion, creates a frozen replacement, and performs exactly one table write. A rejected cumulative or active check performs no write. A rejected write leaves the in-memory state unchanged and maps to `ADMISSION_STATE_IO`.

```ts
async reserveNew(
  input: ReserveNewInput,
  assertActiveCapacity: () => void,
): Promise<RootLedgerRow> {
  return this.serial.run(async () => {
    const current = this.roots.get(input.rootSessionId)
    assertCumulativeCapacity(current, input)
    assertActiveCapacity()
    const next = incrementRootRow(current, input)
    await this.roots.put(input.rootSessionId, next)
    this.probe?.didWrite()
    return next
  })
}
```

- [ ] **Step 5: Run restart and concurrency tests**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/ledger-*.spec.ts`

Expected: PASS for both adapters; 24 concurrent accepted attempts never produce total 25, and reopening preserves all counts.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-subagent-admission/src/host/ledger* packages/dsh-subagent-admission/tests/ledger* packages/dsh-subagent-admission/package.json pnpm-lock.yaml
git commit -m "feat: persist root admission quotas"
```

---

### Task 5: Cooperative single-process ownership guard

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/process-guard.ts`
- Test: `packages/dsh-subagent-admission/tests/process-guard.spec.ts`

**Interfaces:**
- Consumes: configured absolute `ownershipPath`, Node filesystem/process APIs.
- Produces: `ProcessOwnershipGuard.acquire(path)`, `assertHeld()`, `release()`; `OwnershipUnavailable` reason codes `owner-alive`, `owner-corrupt`, `owner-lost`, `owner-io`.

- [ ] **Step 1: Write two-process and stale-owner tests**

```ts
it('allows only one live cooperative owner', async () => {
  const first = await ProcessOwnershipGuard.acquire(lockPath)
  await expect(ProcessOwnershipGuard.acquire(lockPath)).rejects.toMatchObject({ reason: 'owner-alive' })
  await first.release()
  await expect(ProcessOwnershipGuard.acquire(lockPath)).resolves.toBeDefined()
})

it('quarantines a complete dead-pid record before reacquiring', async () => {
  const deadPid = await spawnAndWaitForExit()
  await writeDeadOwner(lockPath, { pid: deadPid, nonce: 'dead', createdAt: 1 })
  const guard = await ProcessOwnershipGuard.acquire(lockPath)
  await expect(guard.assertHeld()).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/process-guard.spec.ts`

Expected: FAIL because the guard is missing.

- [ ] **Step 3: Implement atomic directory ownership without a new native dependency**

Acquire by atomically creating the configured lock directory, then atomically publishing `owner.json` with `{ schemaVersion: 1, pid, nonce, createdAt }`. On `EEXIST`, read and validate the record:

- `process.kill(pid, 0)` success or `EPERM` means a live owner: fail closed;
- `ESRCH` means dead: atomically rename the complete lock directory to a nonce-qualified quarantine name, then retry acquisition;
- missing/corrupt metadata is not auto-deleted: return `owner-corrupt` with a manual recovery path;
- PID reuse may cause a safe false-positive denial; among cooperative plugin processes it cannot grant two owners;
- `assertHeld` checks the nonce before every Strict admission;
- `release` removes only a matching nonce and is idempotent.

- [ ] **Step 4: Run process tests on the current platform**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/process-guard.spec.ts`

Expected: PASS. Mark platform-specific child-process tests for Linux/macOS/Windows CI, not as local unconditional claims.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-subagent-admission/src/host/process-guard.ts packages/dsh-subagent-admission/tests/process-guard.spec.ts
git commit -m "feat: guard single-process admission ownership"
```

---

### Task 6: Active leases, admission authority, permits, and drain

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/leases.ts`
- Create: `packages/dsh-subagent-admission/src/host/authority.ts`
- Test: `packages/dsh-subagent-admission/tests/authority.spec.ts`

**Interfaces:**
- Consumes: `DurableRootResolver`, `RootLedgerStore`, `ProcessOwnershipGuard`, Task 2 protocol/error types.
- Produces: `ActiveLeaseRegistry`, `AdmissionAuthority.prepare(request)`, `AdmissionPermit.bindChild`, `AdmissionPermit.release`, `AdmissionAuthority.closeAdmission()`, `AdmissionAuthority.drain()`.

- [ ] **Step 1: Write the operation-budget and lifecycle tests**

```ts
it('denies before ledger/provider/materialization work', async () => {
  const f = authorityFixture({
    limits: { ...LIMITS, globalActive: 1, perRootActive: 1 },
    parentRoots: { p1: 'r1', p2: 'r2' },
  })
  const held = await f.authority.prepare(request('new-one-shot', 'p1'))
  await expect(f.authority.prepare(request('new-one-shot', 'p2')))
    .rejects.toMatchObject({ code: 'GLOBAL_ACTIVE_LIMIT' })
  expect(f.ledger.writes).toBe(1)
  expect(f.providerCalls).toBe(0)
  expect(f.materializations).toBe(0)
  await held.release('disposed')
})

it('cold resume changes active counts but not cumulative counts', async () => {
  const f = authorityFixture()
  const before = f.ledger.writes
  const permit = await f.authority.prepare(request('cold-resume', 'p', 'existing-child'))
  expect(f.ledger.writes).toBe(before)
  await permit.release('completed')
})
```

Also test root/per-parent/global order, failed ledger write, cancel-before-call, duplicate bind, conflicting bind, duplicate release, provider-start cleanup release, resident follow-up absence from the API, unload rejection, and drain waiting for the last permit.

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/authority.spec.ts`

Expected: FAIL because leases/authority are missing.

- [ ] **Step 3: Implement active checks and linearization**

All new/cold-resume prepares run through one authority serial section:

```ts
return this.serial.run(async () => {
  this.assertOpen()
  await this.guard.assertHeld()
  const lineage = await this.roots.resolve(request.parentSessionId)
  if (request.operation !== 'cold-resume') {
    await this.ledger.reserveNew({
      rootSessionId: lineage.rootSessionId,
      parentSessionId: request.parentSessionId,
      limits: this.limits,
      now: this.clock.now(),
    }, () => this.leases.assertRootThenGlobalCapacity(
      lineage.rootSessionId,
      this.limits,
    ))
  } else {
    this.leases.assertRootThenGlobalCapacity(lineage.rootSessionId, this.limits)
  }
  const lease = this.leases.insert(request, lineage.rootSessionId)
  return this.permitFor(lease)
})
```

The nested ledger callback preserves the frozen decision order: root cumulative, parent cumulative, root active, global active, then one durable reservation. Both ledger and authority serialization remain held through this callback, so capacity cannot change between the checks and lease insertion. For new work, the durable commit plus non-throwing lease insertion is the linearization point. For cold resume, lease insertion is the linearization point. The in-memory insertion path contains no I/O or user callbacks. Any impossible post-commit invariant failure closes Strict admission and records an internal diagnostic; it does not continue with uncertain counters.

- [ ] **Step 4: Implement bind/release and draining**

`bindChild` is at-most-once and validates local parent metadata through the resolver. `release` awaits no provider work itself; the official runtime invokes it only after cleanup. It removes the lease exactly once, emits an authority event, and resolves drain waiters. `closeAdmission` synchronously tombstones new prepares; `drain` waits for `leases.size === 0` while preserving release closures.

- [ ] **Step 5: Run model/authority suites together**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/state-model*.spec.ts packages/dsh-subagent-admission/tests/authority.spec.ts`

Expected: PASS and implementation traces match the pure model for generated operation sequences.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-subagent-admission/src/host/leases.ts packages/dsh-subagent-admission/src/host/authority.ts packages/dsh-subagent-admission/tests/authority.spec.ts
git commit -m "feat: enforce admission permits"
```

---

### Task 7: Non-authoritative telemetry and full-snapshot long polling

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/telemetry.ts`
- Test: `packages/dsh-subagent-admission/tests/telemetry.spec.ts`

**Interfaces:**
- Consumes: authority events and read-only ledger/lease snapshots.
- Produces: `AdmissionTelemetry.record(event)`, `snapshot(sessionId)`, `watch(request, signal)`, process `epoch`, monotonic `revision`.

- [ ] **Step 1: Write ring, epoch, watch, timeout, and privacy tests**

```ts
it('keeps 200 events and reports dropped history', () => {
  const telemetry = makeTelemetry()
  for (let i = 0; i < 205; i += 1) telemetry.record(event(i))
  const snapshot = telemetry.snapshot('root')
  expect(snapshot.history).toHaveLength(200)
  expect(snapshot.droppedHistory).toBe(5)
})

it('never serializes sensitive fields', () => {
  const json = JSON.stringify(makeTelemetry().snapshot('root'))
  for (const forbidden of ['prompt', 'messages', 'toolArguments', 'modelOutput', 'credentials', 'stack']) {
    expect(json).not.toContain(forbidden)
  }
})
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/telemetry.spec.ts`

Expected: FAIL because telemetry is missing.

- [ ] **Step 3: Implement a projector that cannot mutate authority**

The projector receives frozen events after authority transitions. It has no reference to ledger mutation or permit methods. `watch` returns immediately when epoch/revision differ, otherwise waits for change, timeout, or abort and always returns a complete replacement snapshot. Clamp `timeoutMs` to `0..30_000`.

```ts
async watch(request: SnapshotWatchRequest, signal: AbortSignal): Promise<AdmissionSnapshot> {
  if (request.epoch !== this.epoch || request.revision !== this.revision) {
    return this.snapshot(request.sessionId)
  }
  await this.changedOrTimeout(request.timeoutMs, signal)
  return this.snapshot(request.sessionId)
}
```

- [ ] **Step 4: Run and commit**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/telemetry.spec.ts`

Expected: PASS, including aborted long polls without leaked listeners/timers.

```bash
git add packages/dsh-subagent-admission/src/host/telemetry.ts packages/dsh-subagent-admission/tests/telemetry.spec.ts
git commit -m "feat: expose admission snapshots"
```

---

### Task 8: Host service, compatibility modes, bootstrap, and Audit observer

**Files:**
- Create: `packages/dsh-subagent-admission/src/host/compatibility.ts`
- Create: `packages/dsh-subagent-admission/src/host/service.ts`
- Modify: `packages/dsh-subagent-admission/src/index.ts`
- Modify: `packages/dsh-subagent-admission/src/invariant.ts`
- Modify: `packages/dsh-subagent-admission/package.json`
- Modify: `packages/dsh-subagent-admission/tsdown.config.ts`
- Modify: `packages/dsh-subagent-admission/tsconfig.host.json`
- Modify: `packages/dsh-subagent-admission/tsconfig.client.json`
- Modify: `packages/dsh-subagent-admission/tests/manifest.spec.ts`
- Test: `packages/dsh-subagent-admission/tests/service.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–7; Cordis `subagents`, `sessions`, `sessionPersistence`, optional `storageDomain`; lifecycle `subagent/start`/`subagent/end`; Typert protocol.
- Produces: `SubagentAdmissionService`; Cordis key `subagentAdmission`; generated package exports `./typert` and `./remote`; Remote namespace `snapshot` with methods `get` and `watch`; explicit status modes.

- [ ] **Step 1: Write mode truth-table and teardown tests**

```ts
it.each([
  { configured: 'audit', runtime: runtimeWithoutSeam(), baseline: baselineWithoutTargets(), expected: 'audit' },
  { configured: 'strict', runtime: runtimeWithoutSeam(), baseline: baselineWithoutTargets(), expected: 'unavailable' },
  { configured: 'strict', runtime: runtimeWithProtocol(2), baseline: baselineWithProtocolTarget(1), expected: 'unavailable' },
  { configured: 'strict', runtime: runtimeWithProtocol(1), baseline: baselineWithProtocolTarget(1), expected: 'strict' },
])('selects $expected for configured $configured mode', async ({ configured, runtime, baseline, expected }) => {
  const service = await startService({ configured, runtime, baseline })
  expect(service.currentSnapshot('root').mode).toBe(expected)
})

it('tombstones admission before draining storage and guard', async () => {
  const f = await strictServiceFixture()
  const permit = await f.authority.prepare(request('new-one-shot', 'p'))
  const disposing = f.service.dispose()
  await expect(f.authority.prepare(request('new-one-shot', 'p')))
    .rejects.toMatchObject({ code: 'ADMISSION_CLOSED' })
  await permit.release('disposed')
  await disposing
})
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/service.spec.ts`

Expected: FAIL because compatibility/service do not exist.

- [ ] **Step 3: Implement exact compatibility probing**

Strict requires all of:

```ts
runtime.admissionProtocolVersion === 1
typeof runtime.registerAdmissionPolicy === 'function'
baseline.strictTargets.some((target) =>
  target.sourcePackageVersion === runtimeBuild.packageVersion
  && target.protocolVersion === runtime.admissionProtocolVersion
)
storageDomain !== undefined
bootstrap.safe === true
ownershipGuard.held === true
```

Protocol selection is the explicit numeric property, never inferred from a set of methods. Each `strictTargets` row also records the exact official source SHA, patch SHA-256, source package version, and verification command. The runtime can directly attest package version plus protocol only; the snapshot and README must label source-SHA/patch provenance as build-time verification, not a runtime cryptographic attestation. Package semver without the protocol property is never sufficient. A configured Strict failure leaves the service and Snapshot Remote alive in `unavailable`; it registers no policy. Configured Audit never registers a policy even if a seam exists. Before Task 9 records a verified row, the production baseline intentionally makes Strict unavailable; unit tests inject an exact target fixture.

- [ ] **Step 4: Implement bootstrap and Audit observation**

Strict bootstrap validates all listed session headers for complete acyclic parent chains, confirms no conflicting live subagent activation is outside policy ownership, opens the root ledger, and acquires the process guard. If the official runtime cannot enumerate live activations safely, non-empty live subagent state makes Strict unavailable until a clean restart.

Audit subscribes to official start/end lifecycle edges, tracks observed local activity in telemetry, and labels every snapshot `enforced: false`. It does not synthesize cumulative quota truth from historical events.

- [ ] **Step 5: Expose and generate Typert Snapshot methods**

```ts
export class SubagentAdmissionService extends TypertRemoteService {
  constructor(ctx: Context, config: Config) {
    super(ctx, 'subagentAdmission', { namespace: 'snapshot' })
  }

  @Remote('get')
  get(request: SnapshotGetRequest): Promise<AdmissionSnapshot> {
    return Promise.resolve(this.telemetry.snapshot(request.sessionId))
  }

  @Remote('watch')
  watch(request: SnapshotWatchRequest, signal: AbortSignal): Promise<AdmissionSnapshot> {
    return this.telemetry.watch(request, signal)
  }
}
```

The package root exports the service, `Config`, `apply`, and `inject`; no model-facing tool or prompt is registered.

Add `typertPlugin({ mode: 'package', faces: ['host'] })` to the Host build after the service decorators exist. Then add package exports `./typert` and `./remote` pointing only to the generated Host and browser artifacts. Extend `manifest.spec.ts` to require both exports and to reject mutation verbs (`set`, `reset`, `release`, `kill`, `retry`) in the generated Remote schema. Build Host before Client so the Client compiler consumes fresh generated declarations.

- [ ] **Step 6: Run and commit**

Run: `corepack pnpm build && corepack pnpm vitest run packages/dsh-subagent-admission/tests/service.spec.ts packages/dsh-subagent-admission/tests/telemetry.spec.ts packages/dsh-subagent-admission/tests/manifest.spec.ts`

Expected: PASS.

```bash
git add packages/dsh-subagent-admission/package.json packages/dsh-subagent-admission/tsdown.config.ts packages/dsh-subagent-admission/tsconfig.host.json packages/dsh-subagent-admission/tsconfig.client.json packages/dsh-subagent-admission/src/index.ts packages/dsh-subagent-admission/src/invariant.ts packages/dsh-subagent-admission/src/host/compatibility.ts packages/dsh-subagent-admission/src/host/service.ts packages/dsh-subagent-admission/tests/service.spec.ts packages/dsh-subagent-admission/tests/manifest.spec.ts
git commit -m "feat: compose strict and audit host modes"
```

---

### Task 9: Minimal protocol-v1 patch for official `dsh-subagent`

**Files:**
- Create: `patches/dsh-subagent-admission-seam.patch`
- Create: `scripts/verify-seam-patch.mts`
- Create: `tests/upstream/admission-policy.spec.ts`
- Create: `docs/upstream-seam.md`
- Modify: `compatibility/baseline.json`
- External patch targets at `compatibility/baseline.json` source SHA:
  - Modify: `packages/subagent/subagent/src/types.ts`
  - Modify: `packages/subagent/subagent/src/index.ts`
  - Modify: `packages/subagent/subagent/src/continuation.ts`
  - Test: `packages/subagent/subagent/tests/admission-policy.spec.ts`

**Interfaces:**
- Consumes: Task 2 protocol-v1 behavioral shape; official centralized one-shot/continuable/cold-resume lifecycle.
- Produces: official `admissionProtocolVersion: 1`, `registerAdmissionPolicy(policy)`, one-shot/continuable/cold-resume prepare hooks, at-most-once bind, quiescent release, duplicate-registration failure, tombstoned unregister behavior.

- [ ] **Step 1: Write the reusable official-package test and checkout runner**

`tests/upstream/admission-policy.spec.ts` defines a fake policy and calls `ctx.subagents` directly. `verify-seam-patch.mts` checks out only `baseline.source.commit`, verifies the identity, and copies this fixture to the official subagent test directory for the red run. Required cases:

```ts
it('calls policy before provider.start and binds the returned run id', async () => {
  const order: string[] = []
  runtime.registerAdmissionPolicy(policy({ order }))
  provider.start.mockImplementation(async () => {
    order.push('provider')
    return fakeRun('child')
  })
  const run = await runtime.start('fake', request())
  expect(order).toEqual(['prepare', 'provider', 'bind:child'])
  await run.dispose()
  expect(order.at(-1)).toBe('release:disposed')
})
```

Add direct tests for provider rejection cleanup, one-shot result-before-dispose, continuable new child, cold resume, resident follow-up no admission, descendant-delayed `finishDisposal`, duplicate registration, unregister with outstanding permit, foreground/background equivalence, spawn/fork equivalence, and no-policy byte-for-byte behavior.

- [ ] **Step 2: Run against unpatched source and prove the test fails**

Run: `corepack pnpm tsx scripts/verify-seam-patch.mts --expect-unpatched-failure`

Expected: the exact checkout builds, but `admission-policy.spec.ts` fails because the protocol surface is absent.

- [ ] **Step 3: Add the detached official protocol types**

The official patch owns its own types; it does not import this plugin:

```ts
export interface SubagentAdmissionPolicyV1 {
  readonly protocolVersion: 1
  prepare(request: SubagentAdmissionRequestV1): Promise<SubagentAdmissionPermitV1>
}

export interface SubagentAdmissionPermitV1 {
  bindChild(binding: SubagentAdmissionChildBindingV1): void
  release(reason: SubagentAdmissionReleaseReasonV1): Promise<void>
}
```

Requests contain request ID, operation, provider, parent session ID, and optional already-reserved child ID. They contain no trusted root, `Agent`, prompt, provider object, result, handle, or disposal authority.

- [ ] **Step 4: Patch centralized one-shot ownership**

In `SubagentRuntime.start`, preserve existing validation order, then prepare before `provider.start`. On provider rejection, release after the provider's documented cleanup. On success, bind `run.id`, verify `run.localAgent?.session.header.parentSession`, and return a wrapper whose `dispose()` memoizes wrapped disposal followed by permit release. Do not release on `run.result` settlement.

- [ ] **Step 5: Patch continuable creation and cold resume**

Reserve continuable child ID before policy prepare, but call the provider's `prepareContinuable` and Agent materialization only after admission. Store the permit on `Activation`; bind the stable child ID after publication. Cold resume prepares active-only admission with the existing child ID. Resident follow-up reuses the Activation and never calls policy.

At the end of canonical `finishDisposal`, after child-first cleanup, handle disposal, activation removal, and ownership removal, await `permit.release('disposed')`. Every startup/materialization catch path performs official cleanup before release.

- [ ] **Step 6: Implement registration/tombstone behavior**

The runtime exposes literal `admissionProtocolVersion = 1`. Only one policy may register. The disposer synchronously removes/tombstones new policy access; existing permit closures remain valid. Duplicate registration throws a stable `DUPLICATE_ADMISSION_POLICY` subagent error.

- [ ] **Step 7: Generate and verify the patch**

`verify-seam-patch.mts` must:

1. clone/fetch only `baseline.source.commit` into the directory resolved as `.cache/deepseek-harness/${baseline.source.commit}`;
2. verify `git rev-parse HEAD` and a clean tree;
3. run `git apply --check patches/dsh-subagent-admission-seam.patch`;
4. apply it in a disposable copy;
5. install with the official lockfile;
6. run the official subagent package tests plus `admission-policy.spec.ts`;
7. emit a JSON result naming SHA, source version, Node, pnpm, and test command.

Run: `corepack pnpm tsx scripts/verify-seam-patch.mts`

Expected: PASS against the pinned source SHA. If the source/npm baseline changed, refresh/review the patch rather than applying fuzzily.

Only after that PASS, calculate the patch SHA-256 and append one sorted `strictTargets` row for this exact source commit/package version, protocol `1`, and command `corepack pnpm tsx scripts/verify-seam-patch.mts`. Re-run `baseline:check`; the refresh script must preserve the verified row and mark whether it matches the currently observed source.

- [ ] **Step 8: Commit**

```bash
git add patches/dsh-subagent-admission-seam.patch scripts/verify-seam-patch.mts tests/upstream/admission-policy.spec.ts docs/upstream-seam.md compatibility/baseline.json
git commit -m "feat: propose dsh subagent admission seam"
```

---

### Task 10: Strict direct-service conformance, lifecycle barriers, and crash recovery

**Files:**
- Create: `tests/conformance/matrix.ts`
- Create: `tests/conformance/fake-provider.ts`
- Create: `tests/conformance/lifecycle-barriers.ts`
- Create: `tests/conformance/strict-runtime.e2e.ts`
- Create: `tests/conformance/stock-audit.e2e.ts`
- Create: `tests/crash/child.mts`
- Create: `tests/crash/restart.e2e.ts`
- Create: `scripts/run-strict-conformance.mts`
- Create: `scripts/crash-fixture.mts`

**Interfaces:**
- Consumes: complete Host authority, official patch verifier, JSON/SQLite adapters.
- Produces: machine-readable conformance matrix and restart evidence; no production API.

- [ ] **Step 1: Encode the complete matrix as data**

```ts
export const CONFORMANCE_CASES = [
  { provider: 'spawn', shape: 'one-shot', scheduling: 'foreground' },
  { provider: 'spawn', shape: 'one-shot', scheduling: 'background' },
  { provider: 'fork', shape: 'one-shot', scheduling: 'foreground' },
  { provider: 'fork', shape: 'one-shot', scheduling: 'background' },
  { provider: 'spawn', shape: 'continuable', scheduling: 'background' },
  { provider: 'fork', shape: 'continuable', scheduling: 'background' },
] as const
```

Each case runs through direct `ctx.subagents` service calls and the public tool path. Add nested children, ordinary parent fork, cold resume, resident follow-up, cancellations, provider/prepare/materialize failures, cleanup delay, unload, protocol mismatch, duplicate registration, and unsafe bootstrap.

- [ ] **Step 2: Write lifecycle barriers and failing direct-service tests**

The fake Provider/Agent/Handle exposes promises at `beforeProvider`, `beforeMaterialize`, `resultSettled`, `beforeDisposeComplete`, `descendantHeld`, and `finishDisposalComplete`. Tests assert lease state at every barrier, including that result settlement alone does not release one-shot capacity.

Run: `corepack pnpm test:e2e -- tests/conformance/strict-runtime.e2e.ts`

Expected: FAIL until the patched checkout and plugin are composed by the runner.

- [ ] **Step 3: Implement the patched-checkout conformance runner**

`run-strict-conformance.mts` reuses the verified exact checkout, packs the plugin, links/installs it into the checkout's test composition, and runs the matrix with `DSH_ADMISSION_EVIDENCE_DIR` pointing to a temporary directory. It records every case as `pass`, `fail`, or `not-applicable` with a reason; it never converts skipped cases into pass.

- [ ] **Step 4: Add stock Audit conformance**

Install the packed plugin with unpatched npm rc.6. Assert mode Audit, no policy registration, observed start/end telemetry, and zero enforcement claims. A 7th concurrent child must still be allowed by stock DSH in the scripted fixture; the test records that as expected Audit behavior, not a product failure.

- [ ] **Step 5: Add post-ledger-commit crash fixtures for both backends**

The child process accepts exactly one admission, emits `LEDGER_COMMITTED`, and waits before provider/materialization. The driver kills it only after that marker. On restart:

```ts
expect(reopened.root.admittedTotal).toBe(1)
expect(reopened.globalActive).toBe(0)
expect(reopened.activeLeases).toEqual([])
```

Repeat with JSON and SQLite and with the cumulative limit set to 1 so the next new child is denied.

- [ ] **Step 6: Run all conformance/restart gates**

Run:

```bash
corepack pnpm tsx scripts/run-strict-conformance.mts
corepack pnpm tsx scripts/crash-fixture.mts --backend json
corepack pnpm tsx scripts/crash-fixture.mts --backend sqlite
```

Expected: all pinned cases PASS; stock Audit is clearly labelled non-enforcing; raw JSON lands only in the temporary evidence directory.

- [ ] **Step 7: Commit**

```bash
git add tests/conformance tests/crash scripts/run-strict-conformance.mts scripts/crash-fixture.mts
git commit -m "test: verify strict admission lifecycle"
```

---

### Task 11: Generated Snapshot Remote mount and resilient Client controller

**Files:**
- Create: `packages/dsh-subagent-admission/src/client/controller.ts`
- Modify: `packages/dsh-subagent-admission/src/client/index.ts`
- Test: `packages/dsh-subagent-admission/tests/client-controller.client.spec.ts`
- Modify: `packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts`

**Interfaces:**
- Consumes: generated `dsh-subagent-admission/remote`, `ctx.remote.$mount`, `ctx.remote.snapshot.get/watch`, Task 2 snapshot types.
- Produces: `AdmissionSnapshotController` with `getSnapshot`, `subscribe`, `start(sessionId)`, `inject(sessionId)`, and `stop()`; `inject` starts or switches the one active loop and returns `{ hooks: { admission: controller } }` for the native view. There is no Host mutation method.

- [ ] **Step 1: Write controller epoch/revision/reconnect tests**

```ts
it('replaces state with full snapshots and resets on epoch change', async () => {
  const remote = scriptedRemote([
    snapshot({ epoch: 'a', revision: 4 }),
    snapshot({ epoch: 'b', revision: 0 }),
  ])
  const controller = new AdmissionSnapshotController(remote)
  controller.start('root')
  await eventually(() => expect(controller.getSnapshot()?.epoch).toBe('b'))
  expect(remote.watch).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 'a', revision: 4 }), expect.anything())
})
```

Also test abort on session switch/unload, timeout repoll, transient Remote failure with bounded backoff, and no delta merge.

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/client-controller.client.spec.ts`

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Mount the package's generated Remote contribution**

```ts
import snapshotRemote from 'dsh-subagent-admission/remote'

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(snapshotRemote)
  const controller = new AdmissionSnapshotController(ctx.remote.snapshot)
  return async () => {
    controller.stop()
    await disposeRemote()
  }
}
```

Set Client `inject` to `['remote', 'slots', 'locale', 'sessions']`; the package manifest's `dsh.client.inject` remains package-level module ordering.

- [ ] **Step 4: Implement one active long-poll loop**

The controller issues `get` on start, then `watch` with the last full epoch/revision and 25-second timeout. `inject(sessionId)` delegates to idempotent `start(sessionId)` and returns the controller as a `useSyncExternalStore`-compatible hook source. A generation token and AbortController ensure an old session/reconnect response cannot replace current state. Backoff is `250, 500, 1000, 2000, 5000` ms capped, reset by any valid snapshot.

- [ ] **Step 5: Build and test the real closure artifact**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run packages/dsh-subagent-admission/tests/client-controller.client.spec.ts packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts
```

Expected: PASS; the built factory resolves only declared platform modules, inlines its generated Remote/Zod codec, returns `apply`/`inject`, and contains neither the absolute repository path nor the current OS username.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-subagent-admission/src/client packages/dsh-subagent-admission/tests/client-controller.client.spec.ts packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts
git commit -m "feat: connect admission snapshot client"
```

Generated `lib` remains release-only under the Task 1 `.gitignore`; the tarball is always built from fresh output and must contain it.

---

### Task 12: Read-only native Admission Control conversation view

**Files:**
- Create: `packages/dsh-subagent-admission/src/client/AdmissionControlView.tsx`
- Create: `packages/dsh-subagent-admission/src/client/styles.ts`
- Create: `packages/dsh-subagent-admission/src/client/locales.ts`
- Modify: `packages/dsh-subagent-admission/src/client/index.ts`
- Test: `packages/dsh-subagent-admission/tests/admission-view.client.spec.tsx`

**Interfaces:**
- Consumes: `AdmissionSnapshotController`, DSH `conversation.view`, locale service, selected `sessionId`.
- Produces: tab ID `admission-control`, order `20`, label “Admission Control”/“准入控制”; status, four quota cards, leases, history; no action callback.

- [ ] **Step 1: Write semantic and forbidden-control tests**

```tsx
it('renders status, all four quotas, leases, and history without mutations', async () => {
  render(<AdmissionControlView {...propsFor(strictSnapshot())} />)
  expect(screen.getByRole('status')).toHaveTextContent('Strict')
  expect(screen.getAllByTestId('quota-card')).toHaveLength(4)
  expect(screen.getByRole('table', { name: 'Active leases' })).toBeVisible()
  for (const label of ['Kill', 'Reset', 'Force release', 'Retry', 'Edit quota']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  }
})
```

Add Audit/Unavailable/Draining copy, empty states, dropped-history warning, keyboard tab switching through the real slot ring, locale switching, and color-independent icon/text labels.

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run packages/dsh-subagent-admission/tests/admission-view.client.spec.tsx`

Expected: FAIL because the view does not exist.

- [ ] **Step 3: Implement the four fixed sections**

`AdmissionControlView` has no mutation props. It renders:

```tsx
<section aria-labelledby="admission-control-title">
  <PolicyStatus status={snapshot.status} />
  <QuotaGrid quotas={quotaCards(snapshot)} />
  <ActiveLeaseTable leases={snapshot.activeLeases} />
  <AdmissionHistory events={snapshot.history} dropped={snapshot.droppedHistory} />
</section>
```

Use compact responsive CSS injected by `ensureAdmissionStyles()`. The disposer removes only `style[data-plugin="dsh-subagent-admission"]`. Text and symbols communicate every status without relying on green/red alone.

- [ ] **Step 4: Register the native view**

```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'admission-control',
  order: 20,
  locale: NS,
  label: () => t('view.label'),
  inject: (sessionId: SessionId) => controller.inject(sessionId),
}, AdmissionControlView))
```

The registration is additive and leaves Chat/Trajectory intact. Fiber disposal removes the view, stops polling, unregisters locale/style, and unmounts the Remote contribution in reverse order.

- [ ] **Step 5: Run component and built-bundle tests**

Run:

```bash
corepack pnpm vitest run packages/dsh-subagent-admission/tests/admission-view.client.spec.tsx packages/dsh-subagent-admission/tests/client-bundle.client.spec.ts
corepack pnpm build
```

Expected: PASS; no visual-completion claim is made until a later real DSH screenshot is captured during packed-install QA.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-subagent-admission/src/client packages/dsh-subagent-admission/tests/admission-view.client.spec.tsx
git commit -m "feat: add admission control view"
```

---

### Task 13: Packed installation, exact CI matrix, and upstream drift monitor

**Files:**
- Create: `scripts/packed-install.mts`
- Create: `tests/packed-install.e2e.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/upstream-drift.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: built tarball, stock npm rc.6, patched source fixture.
- Produces: local packed-install report; blocking exact matrix; informative master-drift result.

- [ ] **Step 1: Write packed-install acceptance tests**

The test creates a temporary `DSH_HOME`, lets the official CLI initialize the shipped `web` profile, resolves `dist/dsh-subagent-admission-0.1.0-rc.1.tgz` to an absolute path, and passes that value as the final `execFile` argument after `['pnpm', 'exec', 'dsh', 'plugin', '--profile', 'web', 'add']`. It then runs `corepack pnpm exec dsh --profile web --dump-config`, boots with a scripted-provider overlay, and checks:

```ts
expect(dump).toContain('# == dsh-subagent-admission')
expect(dump).toContain('id: subagent-admission')
expect(stockSnapshot.mode).toBe('audit')
expect(clientBoot.pluginIds).toContain('dsh-subagent-admission')
```

It then runs a patched Strict fixture and expects `mode: 'strict'` plus denial of the 7th globally concurrent activation before provider work. Distribute the first six activations across at least two roots so the per-root limit does not mask the global-limit assertion.

- [ ] **Step 2: Run and verify the installer test fails before the driver exists**

Run: `corepack pnpm test:e2e -- tests/packed-install.e2e.ts`

Expected: FAIL because `packed-install.mts` is absent.

- [ ] **Step 3: Implement isolated pack/install and native GUI proof**

The script uses `mkdtemp`, absolute validated paths, and local tarballs only. It never edits the user's real profile. It records package integrity hash, `lib/client.js` hash, profile dump hash, DSH package versions, mode, Node/platform, and command exit codes. With `--capture-gui`, it boots the packed plugin in the temporary `web` profile on a loopback ephemeral port with deterministic fake-provider data and a fixed clock, opens it in Playwright Chromium, selects `Admission Control`, asserts the status text, four quota cards, active/history sections, and absence of mutation controls, then writes the requested ignored candidate PNG and its SHA-256 into the packed-install report. Cleanup removes only its exact temporary directory and always terminates the web child.

After capture, inspect the PNG at native resolution. The visual gate requires the displayed mode and enforcement truth to be readable, no clipped card/table content at 1440×900, visible focus state, and no layout displacement of Chat or Trajectory. Record this as agent visual QA only; do not call it human review or kernel evidence.

- [ ] **Step 4: Add blocking CI**

`.github/workflows/ci.yml` contains:

- Linux Node 22.19 and Node 24 each run `pnpm baseline:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm tsx scripts/run-strict-conformance.mts`, both `pnpm tsx scripts/crash-fixture.mts --backend` variants, and `pnpm test:e2e -- tests/packed-install.e2e.ts`; the Node 24 job also runs `pnpm exec playwright install --with-deps chromium` and captures to ignored `evidence/ci-admission-control.png` as an artifact-only reproducibility check;
- macOS Node 24 and Windows Node 24 each run the focused process-guard suite, `pnpm build`, `pnpm test:e2e -- tests/packed-install.e2e.ts --audit-only`, and the Admission view/client-bundle browser-mount suites;
- artifact upload for raw test/evidence JSON only on all-success or diagnostic failure, clearly labelled.

No API secrets are used.

- [ ] **Step 5: Add non-blocking upstream drift workflow**

Run daily/manual `baseline:check` against official master/npm. A mismatch uploads the generated candidate baseline and opens no issue/PR. It is allowed to fail informatively and never rewrites the pinned blocking matrix.

- [ ] **Step 6: Run local gates and commit**

Run:

```bash
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e -- tests/packed-install.e2e.ts
corepack pnpm exec playwright install chromium
corepack pnpm tsx scripts/packed-install.mts --capture-gui --screenshot evidence/admission-control.png
```

Expected: PASS for supported local gates; platform-only jobs remain unclaimed until CI completes.

```bash
git add scripts/packed-install.mts tests/packed-install.e2e.ts .github package.json
git commit -m "ci: verify packed dsh installation"
```

---

### Task 14: Reproducible benchmarks and safe #131 workload

**Files:**
- Create: `scripts/benchmark.mts`
- Create: `scripts/reproduce-131.mts`
- Create: `tests/benchmark.spec.ts`
- Create: `docs/reproduction.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: fake provider/lifecycle barriers, stock Audit and patched Strict fixtures.
- Produces: versioned raw JSON for denial, accepted admission, cold resume, release, snapshot, contention, and bounded-vs-unbounded workload; no hard p95 release threshold yet.

- [ ] **Step 1: Write output-schema and reproducibility tests**

```ts
it('records raw samples and complete environment identity', async () => {
  const report = await runBenchmark({ iterations: 50, warmup: 10, clock: monotonicClock })
  expect(report.schemaVersion).toBe(1)
  expect(report.environment).toMatchObject({ node: expect.any(String), platform: expect.any(String) })
  expect(report.cases.denied.samples).toHaveLength(50)
  expect(report.cases.denied.summary.p95).toBe(percentile(report.cases.denied.samples, 0.95))
})
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run tests/benchmark.spec.ts`

Expected: FAIL because the benchmark module does not exist.

- [ ] **Step 3: Implement raw-sample benchmarks**

Add these exact root scripts while implementing the runners:

```json
{
  "benchmark": "tsx scripts/benchmark.mts",
  "reproduce:131": "tsx scripts/reproduce-131.mts"
}
```

Use `performance.now()`/`process.hrtime.bigint()`, explicit warmup, fixed iteration count, one-process environment, and no network/model API. Cases:

- denied admission;
- accepted new admission and exactly one ledger write;
- cold-resume admission and zero ledger writes;
- release after an opened cleanup barrier;
- snapshot get/watch;
- 64 concurrent check/reserve races.

Write raw samples before derived median/p95. Never compare unlike Node/platform/storage combinations as one regression number.

- [ ] **Step 4: Implement the safe #131 reproduction**

The scripted provider creates the same requested shape—56 nested spawn/fork continuable background children and frequent session writes—without an external model or API key. Run stock Audit first with a hard process timeout and memory ceiling; run Strict second with defaults and assert that provider starts never exceed six globally or four for one root while excess calls receive typed fail-fast denials.

The script prints a confirmation summary before the stock stress phase and requires `--allow-stock-stress`; CI uses a reduced deterministic fixture, not an uncontrolled live web server.

- [ ] **Step 5: Run and document**

Run:

```bash
corepack pnpm benchmark -- --iterations 100 --output evidence/local-benchmark.json
corepack pnpm reproduce:131 -- --strict-only --output evidence/local-reproduction.json
```

Expected: valid raw JSON. Do not commit machine-specific local result files; commit commands/schema/docs only.

- [ ] **Step 6: Commit**

```bash
git add scripts/benchmark.mts scripts/reproduce-131.mts tests/benchmark.spec.ts docs/reproduction.md package.json
git commit -m "test: add admission performance evidence"
```

---

### Task 15: Release documentation and evidence manifest without publication

**Files:**
- Create: `README.md`
- Create: `README.zh-CN.md`
- Create: `docs/assets/admission-control.png`
- Create: `docs/architecture.md`
- Create: `docs/compatibility.md`
- Modify: `compatibility/ecosystem-audit.md`
- Modify: `docs/upstream-seam.md`
- Modify: `docs/reproduction.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `scripts/sync-package-docs.mts`
- Create: `scripts/release-evidence.mts`
- Create: `evidence/.gitkeep`
- Create: `packages/dsh-subagent-admission/README.md`
- Create: `packages/dsh-subagent-admission/README.zh-CN.md`
- Create: `packages/dsh-subagent-admission/LICENSE`
- Modify: `packages/dsh-subagent-admission/package.json`

**Interfaces:**
- Consumes: all verified commands/artifacts from Tasks 1–14.
- Produces: release-candidate documentation, a local evidence manifest, and a packable `v0.1.0-rc.1` candidate; no external release.

- [ ] **Step 1: Write documentation truth tests**

Add `tests/docs.spec.ts` asserting both READMEs contain:

```ts
for (const readme of ['README.md', 'README.zh-CN.md']) {
  const text = readFileSync(readme, 'utf8')
  expect(text).toContain('Strict')
  expect(text).toContain('Audit')
  expect(text).toContain('single-process')
  expect(text).toContain('no process isolation')
  expect(text).toContain('Discussion #131')
  expect(text).not.toMatch(/officially endorsed|official plugin/i)
}
```

Also validate that every compatibility row names exact versions/SHAs and either a checked verification command or a generated evidence path.
Assert `docs/assets/admission-control.png` is a non-empty PNG and both root READMEs label it as GUI rendering evidence rather than enforcement evidence.

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm vitest run tests/docs.spec.ts`

Expected: FAIL because release docs are absent.

- [ ] **Step 3: Write the English/Chinese README first screens**

Both begin with the same truth banner:

> Strict requires the protocol-v1 admission seam. Audit works on stock DSH and does not enforce limits.

Then include #131 scope, exact default guarantees, non-goals, the install command `dsh plugin --profile web add ./dsh-subagent-admission-0.1.0-rc.1.tgz`, compatibility/coverage matrices, and links to raw conformance/crash/benchmark evidence. Embed the final screenshot promoted in Step 7 from a fresh packed-install candidate, with a caption that says it proves only GUI installation/rendering; do not substitute a mock. `sync-package-docs.mts` copies concise package-facing English/Chinese READMEs and the repository MIT `LICENSE` into the nested package, then verifies byte equality for the license and mode-truth/install sections before packing. Extend the package `files` allowlist with both READMEs, `LICENSE`, `lib/typert.host.js`, `lib/typert.host.d.ts`, `lib/typert.remote-client.js`, and `lib/typert.remote-client.d.ts`; do not replace it with a broad `lib` directory entry.

- [ ] **Step 4: Write architecture, compatibility, seam, reproduction, security, and attribution docs**

`THIRD_PARTY_NOTICES.md` attributes the standalone client-bundle pattern to the pinned MIT DeepSeek Harness source file. `SECURITY.md` documents prompts/secrets exclusion, lock/ledger paths, single-user local filesystem assumptions, reporting route, and that install/build permissions execute package code. `CHANGELOG.md` lists only verified rc.1 behavior.

Repeat Task 1's direct-source ecosystem scan immediately before the release gate and update `compatibility/ecosystem-audit.md` with exact observed identities. If an official or community implementation now closes the residual demand, stop for Go/Reframe/Kill rather than publishing by inertia.

- [ ] **Step 5: Implement the evidence aggregator**

`release-evidence.mts --run` invokes the exact pinned commands and writes these ignored working files: `evidence/conformance.json`, `evidence/crash-json.json`, `evidence/crash-sqlite.json`, `evidence/packed-install.json`, `evidence/benchmark.json`, `evidence/reproduction-strict.json`, and `evidence/admission-control.png`. The packed-install producer captures that PNG from the current tarball. Before promotion, the aggregator validates the candidate screenshot and requires the report's `lib/client.js` hash to equal the freshly packed client bundle, then constructs the manifest from resolved values:

```ts
const manifest: ReleaseEvidenceV1 = {
  schemaVersion: 1,
  release: packageManifest.version,
  sourceCommit: await readGitHead(repositoryRoot),
  compatibilityBaselineSha256: await sha256File(baselinePath),
  artifacts: await Promise.all(requiredEvidence.map(async (artifact) => ({
    kind: artifact.kind,
    path: relative(repositoryRoot, artifact.path),
    sha256: await sha256File(artifact.path),
    status: artifact.requiredStatus,
  }))),
}
```

`requiredEvidence` is the fixed typed list of those seven generated paths. Conformance and the three installation-or-crash reports must be `pass`; benchmark and strict-only reproduction must be `measured`; the screenshot is `captured` and carries an agent visual-QA label without a human-review claim. The script rejects missing, stale, failed, path-escaping, client-bundle-mismatched, or identity-mismatched input artifacts. After the fresh ignored PNG passes native-resolution visual inspection, `--promote-gui docs/assets/admission-control.png` revalidates the complete candidate and atomically copies those exact bytes into the tracked documentation path; it must never recapture or accept a different source. Once the tracked image exists, both `--run` and `--manifest-only` require exact screenshot hash equality. `--manifest-only` performs validation and hashing without rerunning the producers.

- [ ] **Step 6: Run the pre-promotion local release candidate gate**

Run:

```bash
corepack pnpm baseline:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm vitest run --exclude tests/docs.spec.ts
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm tsx scripts/sync-package-docs.mts --check
corepack pnpm pack:plugin
corepack pnpm tsx scripts/release-evidence.mts --run --output evidence/release-candidate.json
```

Expected: all non-documentation supported local gates PASS and a fresh ignored `evidence/admission-control.png` is bound to the current tarball; platform-limited checks remain explicitly labelled.

- [ ] **Step 7: Inspect and promote the exact GUI candidate**

Inspect `evidence/admission-control.png` at native 1440x900 resolution. Require readable mode/enforcement truth, no clipped cards or tables, visible focus state, and no displacement of Chat or Trajectory. Record this as agent visual QA only. Then run:

```bash
corepack pnpm tsx scripts/release-evidence.mts --manifest-only --promote-gui docs/assets/admission-control.png --output evidence/release-candidate.json
```

Expected: the tracked PNG is byte-identical to the inspected ignored candidate and remains labelled as GUI rendering evidence, not enforcement or human-review evidence.

- [ ] **Step 8: Run the complete gate, stage, and inspect**

Run:

```bash
corepack pnpm baseline:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
corepack pnpm tsx scripts/sync-package-docs.mts --check
corepack pnpm pack:plugin
corepack pnpm tsx scripts/release-evidence.mts --manifest-only --output evidence/release-candidate.json
git add README.md README.zh-CN.md docs compatibility/ecosystem-audit.md SECURITY.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md scripts/sync-package-docs.mts scripts/release-evidence.mts evidence/.gitkeep packages/dsh-subagent-admission/package.json packages/dsh-subagent-admission/README.md packages/dsh-subagent-admission/README.zh-CN.md packages/dsh-subagent-admission/LICENSE tests/docs.spec.ts
git diff --cached --check
```

Expected: all supported local gates PASS; the tracked screenshot hash equals the visually inspected ignored candidate; generated evidence identifies platform-limited checks and does not claim macOS/Windows CI until those jobs pass.

- [ ] **Step 9: Commit the release-candidate documentation**

```bash
git commit -m "docs: prepare admission release candidate"
```

Stop here. Do not push, publish, tag, create a GitHub repository/release, alter the profile, reply to #131, or post externally. Present fresh gate output and request separate release authorization.

- [ ] **Step 10: Rebind the ignored evidence manifest to the committed candidate**

Run:

```bash
corepack pnpm tsx scripts/release-evidence.mts --run --output evidence/release-candidate.json
node -e "const fs=require('node:fs'),cp=require('node:child_process');const m=JSON.parse(fs.readFileSync('evidence/release-candidate.json','utf8'));const h=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(m.sourceCommit!==h)process.exit(1)"
git status --short
```

Expected: the manifest names the new documentation commit; generated evidence remains ignored, and the tracked tree is clean. Do not amend the commit or stage generated reports.

---

## Spec-to-Task Traceability

| Frozen design requirement | Implemented/verified by |
| --- | --- |
| Four fail-fast quotas and fixed violation order | Tasks 2, 6 |
| New/cold/resident operation semantics | Tasks 2, 6, 9, 10 |
| No pre-admission provider/materialization/write work | Tasks 6, 9, 10 |
| One durable write per accepted new child | Tasks 4, 6, 10 |
| Stable root through ordinary forks | Tasks 3, 10 |
| Cumulative durability and post-commit crash | Tasks 4, 10 |
| Process-local active leases and single-owner guard | Tasks 5, 6, 10 |
| Quiescent one-shot/continuable release | Tasks 6, 9, 10 |
| Versioned optional official seam | Task 9 |
| Strict/Audit/Unavailable/Draining truth | Tasks 8, 10, 13 |
| Read-only full-snapshot RPC and 200-event ring | Tasks 7, 8, 11 |
| Privacy boundary | Tasks 2, 7, 10, 12 |
| Native `conversation.view` UI without controls | Task 12 |
| Packed native GUI capture and visual truth gate | Task 13 |
| JSON and SQLite equivalence | Tasks 4, 10 |
| Direct-service/tool/provider coverage | Tasks 9, 10 |
| Exact pin, packed install, Node/platform CI, drift monitor | Tasks 1, 13 |
| Reproducible benchmark and #131 workload | Task 14 |
| Bilingual release evidence and publication boundaries | Task 15 |

## Execution Notes

- Use a fresh implementation worktree on branch `codex/dsh-subagent-admission-v0.1` when execution starts; the current repository is on `main` with only design/planning commits.
- The first implementation checkpoint is Task 1's refreshed baseline. If official source/npm alignment or public APIs changed, update the baseline and the plan's concrete package pins before writing behavior, then request review if semantics would change.
- Each task gets its own fresh worker and review gate under subagent-driven execution. Do not parallelize tasks that share authority/storage types; Tasks 11 and 12 may only begin after Host contracts and generated Remote artifacts stabilize.
- Keep generated evidence out of commits until Task 15 validates it. Static docs and schemas are not proof that a test, install, CI job, release, Discussion post, adoption, or hiring outcome occurred.
