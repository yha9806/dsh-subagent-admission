# Reproducing admission behaviour safely

This repository provides two local, no-model evidence producers: a raw
admission-kernel benchmark and a bounded structural reproduction of
[DeepSeek Harness Discussion #131](https://github.com/deepseek-ai/deepseek-harness/discussions/131).
Neither command needs an API key or makes a model or network request.

## Evidence boundary

The #131 producer recreates the request shape at the admission seam: 56
binary-nested children, alternating `spawn` and `fork`, marked as continuable
background work, with eight deterministic JSONL appends per provider start in
an isolated temporary directory. The parent owns and removes the stock-worker
directory. This filesystem fixture is **not** DSH session persistence and does
not claim to make a real DSH Web server unresponsive or run an LLM. Real
stock-plugin installation and patched-runtime wiring are proved separately by
the packed-install and exact-target conformance gates.

The policy-absent stock-equivalent phase runs in a child process with both a
hard timeout and a V8 old-space ceiling. It is intentionally opt-in. The Strict
phase runs the production `AdmissionAuthority` and default limits. Descendants
of a denied node are suppressed, matching fail-fast branch termination rather
than fabricating sessions that were never created.

## Safe commands

Run only the bounded Strict side (the release-evidence default):

```bash
pnpm reproduce:131 -- --strict-only --output evidence/local-reproduction.json
```

Run the stock-equivalent phase first and then Strict only after reviewing the
printed confirmation summary:

```bash
pnpm reproduce:131 -- --allow-stock-stress --output evidence/local-reproduction-full.json
```

The stock phase is refused unless `--allow-stock-stress` is present. Its
defaults are a 15-second process timeout and a 128 MiB V8 old-space ceiling.
The ceiling limits V8 old space, not total process RSS. For CI, use a reduced
deterministic shape rather than the stock phase:

```bash
pnpm reproduce:131 -- --strict-only --children 12 --output evidence/reproduction-strict-reduced.json
```

With the default 56-child binary topology, one-root Strict should start at most
four providers, return typed `ROOT_ACTIVE_LIMIT` denials for the still-reachable
excess branches, and suppress their descendants. A separate two-root probe
holds six permits and verifies that the seventh request returns
`GLOBAL_ACTIVE_LIMIT` before provider work.

## Raw benchmark

Produce 100 measured samples per case after ten warmup operations:

```bash
pnpm benchmark -- --iterations 100 --output evidence/local-benchmark.json
```

The versioned JSON keeps raw nanosecond samples before summaries and records
Node, platform, architecture, CPU, DSH package version, plugin version, storage
fixture, warmup, and iteration count. It measures:

- denied admission;
- accepted new admission through exactly one instrumented ledger write;
- cold resume with zero cumulative writes;
- release after the external cleanup boundary is open;
- snapshot get and stale-epoch watch;
- 64-way concurrent check/reserve races.

The first release publishes measurements, not an invented p95 threshold.
Compare only reports with matching Node, platform, architecture, storage, and
workload parameters. Machine-specific files under `evidence/` remain ignored
and are not source-controlled proof that CI or another machine passed.
