# Changelog

All notable changes to this project are documented here. The project follows
semantic versioning only after a version is actually published; local release
candidates do not imply npm availability or upstream adoption.

## Unreleased

### Changed

- Reframed the project from a generic subagent limiter to a shared lifecycle
  admission protocol plus reference policy kernel.
- Acknowledged and bounded current DSH plugin precedents, including
  `dsh-background-agents`, AgentTeams, and Delegate.
- Added bilingual release documentation, exact compatibility policy, security
  boundary, third-party notices, and reproducible release-evidence manifest.

## 0.1.0-rc.1 — 2026-08-14

Local release candidate; not published.

### Added

- Fail-fast `AdmissionAuthority` with global/root active capacity, durable
  root/parent cumulative quotas, and typed denials.
- Permit/lease ownership through one-shot, continuable, cold-resume, cleanup,
  drain, and crash/restart paths.
- JSON and SQLite storage-domain ledger implementations plus cooperative
  single-process ownership guard.
- Audit, Strict, Unavailable, and Draining mode truth with exact target
  compatibility selection.
- Minimal protocol-v1 patch for one pinned DeepSeek Harness source commit and a
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
