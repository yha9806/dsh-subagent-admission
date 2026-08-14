# Security Policy

## Supported Versions and Reporting

`0.1.0-rc.1` is an unpublished release candidate. No version is currently
declared production-supported.

When this repository enables GitHub private vulnerability reporting, use that
channel. Until then, open a minimal issue that contains no exploit, secret,
private session data, or sensitive reproduction detail and request a private
contact path from the maintainer. Do not post weaponisable bypass details in a
public Discussion.

Please include the exact plugin commit, DSH source/package identities, mode,
storage backend, operating system, Node version, configuration with secrets
removed, and the smallest safe reproduction. Never include API keys, prompts,
model output, credentials, or private session logs unless a private channel has
been agreed and the data owner authorises disclosure.

## System and Scope

This policy covers:

- the external admission policy, root resolver, active lease registry, durable
  JSON/SQLite ledger, process ownership guard, and disposal path;
- the optional protocol-v1 reference patch for official `SubagentRuntime`;
- exact-build compatibility selection and Strict/Audit/Unavailable mode truth;
- bounded telemetry, read-only Snapshot Remote, and native GUI;
- package, baseline, patch, conformance, crash, reproduction, benchmark, and
  release-evidence tooling.

The important assets are Host availability, correct admission accounting,
immutable root ownership, cumulative quota persistence, exact mode reporting,
session identifiers used for ownership, and the absence of sensitive content
from errors and telemetry.

## Threat Model and Trust Boundaries

Potentially attacker-controlled or malformed inputs include plugin
configuration, Remote request fields, parent/child session identifiers,
persisted session lineage, ledger records, cancellation timing, provider
failure, process crash timing, and concurrent start/resume calls.

The DSH Host administrator, the exact official runtime build selected for
Strict, the local filesystem permissions, and cooperative in-process plugins
are trusted. A malicious peer plugin can execute in the same Node process and
is outside the isolation capability of v0.1; this assumption does not excuse a
bypass reachable through ordinary public DSH APIs used by a non-malicious
plugin.

Prompts, messages, model output, tool arguments, provider credentials, and
borrowed `Agent`/provider objects must not cross the admission protocol. The
read-only GUI and telemetry are diagnostic consumers, never authoritative
decision inputs.

## Security Invariants

In Strict mode:

1. only an exact protocol-v1 compatibility target may register enforcement;
2. missing identity, storage, safe bootstrap, lineage, or exclusive process
   ownership fails closed as Unavailable;
3. all covered start and cold-resume paths acquire admission before provider
   work, child materialisation, model request, or session artifact creation;
4. concurrent reservations cannot exceed global/root active or root/parent
   cumulative limits;
5. each live activation owns exactly one unreleased permit, and release occurs
   only after official quiescent cleanup;
6. denial changes no authoritative state and starts no provider work;
7. root binding is immutable and must agree with durable parent lineage;
8. cumulative admissions survive restart while dead-process active leases do
   not;
9. policy unload closes new admission synchronously before drain and cannot
   silently restore policy-absent stock behaviour in the same runtime;
10. errors, snapshots, history, logs, and evidence exclude prompts, messages,
    outputs, credentials, and unbounded caller-controlled content;
11. Remote and GUI surfaces remain read-only—no force release, kill, reset,
    retry, or quota-edit method may appear;
12. cleanup and temporary-path tooling must validate exact owned paths before
    destructive removal.

Audit mode must always report `enforced: false` and must not register a policy.

## Reportable Findings and Severity Context

Reportable examples include:

- an ordinary built-in, plugin, provider, SDK, or direct runtime path that can
  bypass active Strict admission before materialisation;
- a race that exceeds configured limits or double-consumes/refunds quota;
- early release while provider/agent/descendant resources remain live;
- root reassignment, lineage confusion, ledger rollback, or restart behaviour
  that lets one root consume another root's budget;
- Strict activating on an unverified build, or silently degrading while still
  reporting `enforced: true`;
- mutation through the nominally read-only Remote or GUI;
- leakage of prompts, outputs, credentials, private session content, or
  unbounded attacker input through diagnostics/evidence;
- unsafe path handling that can overwrite or delete files outside a verified
  temporary/evidence target;
- denial of service reachable before configured admission limits through the
  policy's own parser, lock, ledger, watcher, or telemetry implementation.

Severity depends on realistic reachability and impact. A cross-caller Strict
bypass, arbitrary file modification, credential/session leakage, or persistent
root-accounting corruption is more severe than a bounded diagnostic mismatch
without enforcement impact.

## Out of Scope and Accepted Risk

The following are known product boundaries, not blanket finding suppressions:

- Audit does not prevent starts; presenting Audit as enforcement remains a bug.
- v0.1 is single-process and has no multi-process, multi-host, distributed, or
  remote-compute ownership guarantee.
- v0.1 provides no OS process isolation, memory/CPU sandbox, provider-rate
  limiter, token/cost budget, scheduler, priority, pre-emption, or force kill.
- a fully malicious in-process plugin can corrupt shared process memory or call
  Node APIs directly; ordinary API-level Strict bypasses remain reportable.
- model quality, hallucination, prompt injection confined to model behaviour,
  and harmful model output are out of scope unless they cross a documented
  admission/security boundary.
- resource exhaustion that remains inside configured admitted capacity is not
  automatically a policy vulnerability; an avoidable amplification in the
  kernel itself may still be reportable.
- the reference patch is not upstream acceptance, and absence of official
  adoption is not a security defect.

## Known Limitations and Compensating Controls

- Exact source and patch hashes plus RED/GREEN conformance reduce accidental
  drift; they do not prove every deployment.
- The ownership guard rejects a second cooperative Host for one ledger
  namespace; it is not a distributed lock or defence against a malicious
  process.
- Active leases intentionally reset after process death; cumulative ledger
  state and a safe no-live-child bootstrap compensate for restart ambiguity.
- Failed canonical cleanup deliberately retains capacity rather than asserting
  quiescence without evidence. Recovery may require operator restart; there is
  no force-release escape hatch.
- Generated evidence is machine- and source-fingerprint-bound and ignored by
  Git. A tracked screenshot is integration evidence only, not human review or
  security certification.
