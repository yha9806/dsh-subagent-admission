# Changelog

All notable changes to this project are documented here. The project follows
semantic versioning only after a version is actually published; local release
candidates do not imply npm availability or upstream adoption.

## 0.1.0-rc.1 — 2026-08-14

GitHub prerelease for the reference implementation, conformance system, and
upstream design prototype. Source and reproducible local package artifacts are
public, but the package is not published to npm. This prerelease does not imply
DeepSeek adoption, maintainer endorsement, production deployment, or a
zero-patch Strict installation path.

### Changed

- Promoted the qualified slim admission seam candidate (`patches/dsh-subagent-admission-seam-slim.patch`, SHA-256 `1a3e351cab75ff22d55b0d2a8cb458cbee2794a769cb2f433e105dd421636073`) to the canonical local exact-target baseline.
- Adopted the cancellable `acquire(request, signal)` protocol signature across one-shot and continuable subagent materialization paths.
- Unified release reason vocabulary with explicit `startup-failed` on rejected provider startup or rollback and quiescent release after completed teardown.
- Expanded conformance testing with cancellation before provider startup and cancellation after admission acquisition.
- Closed the cold-resume cancellation window after policy acquisition so an untransferred permit releases with `startup-failed` before materialization begins.
- Qualified the slim seam patch to 230 changed lines (207 insertions, 23 deletions) across 3 official files (106 changed lines in `continuation.ts`, 455 serialized patch lines), reducing official footprint while preserving full lifecycle semantics.
- Retained the reference patch (`patches/dsh-subagent-admission-seam.patch`, SHA-256 `1340a9ffabde8310f68a7d66c4dacecda5dba263dd51666740801f5ec2c69135`) as an explicitly selectable, fully verifiable recoverable artifact.
- Preserved external boundaries: this promotion updates local canonical identity and test defaults only; it makes no claim of upstream DeepSeek adoption, maintainer endorsement, or npm package publication.
- Reframed the project from a generic subagent limiter to a shared lifecycle
  admission protocol plus reference policy kernel.
- Acknowledged and bounded current DSH plugin precedents, including
  `dsh-turn-budget`, `dsh-background-agents`, AgentTeams, and Delegate.
- Added bilingual release documentation, exact compatibility policy, security
  boundary, third-party notices, and reproducible release-evidence manifest.
- Defined `perRootAdmittedTotal` as a non-refundable, non-resetting v0.1
  lifetime fuse and documented zero-patch Strict as the productization gate.
- Fixed packed-install pnpm command resolution on Windows by selecting
  `pnpm.cmd`, routing command shims through `cmd.exe`, and preserving an
  explicit `DSH_PNPM_BIN` override.
- Separated platform-independent packed commands from their physical process
  invocations in evidence reports, preserving both stable semantics and the
  exact Windows `cmd.exe` launcher record.
- Enabled the reviewed, exact-lock `node-pty` Linux native build and
  `dsh-subprocess-local` helper-permission scripts required by the packed stock
  Web acceptance gate.

### Added

- Fail-fast `AdmissionAuthority` with global/root active capacity, durable
  root/parent cumulative quotas, and typed denials.
- Permit/lease ownership through one-shot, continuable, cold-resume, cleanup,
  drain, and crash/restart paths.
- JSON and SQLite storage-domain ledger implementations plus cooperative
  single-process ownership guard.
- Audit, Strict, Unavailable, and Draining mode truth with exact target
  compatibility selection.
- Experimental protocol-v1 patch for one pinned DeepSeek Harness source commit and a
  reusable upstream conformance fixture.
- Read-only Snapshot Remote and native Admission Control conversation view.
- Packed stock-Audit/exact-target-Strict installation tests, native GUI capture,
  structural Discussion #131 reproduction, benchmark producer, and CI/drift
  workflow configuration.

### Known limits

- Strict is verified only for the exact source target in
  `compatibility/baseline.json`.
- Correctness is single-process and cooperative; there is no OS isolation or
  distributed admission.
- CI configuration, local evidence, publication, production use, official
  acceptance, and hiring outcomes remain separate claims.
