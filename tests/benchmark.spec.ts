import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  percentile,
  runBenchmark,
  type BenchmarkClock,
} from '../scripts/benchmark.mts'
import { runReproduction131 } from '../scripts/reproduce-131.mts'

function deterministicClock(step = 100n): BenchmarkClock {
  let value = 0n
  return {
    now(): bigint {
      value += step
      return value
    },
  }
}

function reproductionTempRoots(): readonly string[] {
  return readdirSync(tmpdir())
    .filter(name => name.startsWith('dsh-reproduce-131-'))
    .sort()
}

describe('admission benchmark report', () => {
  it('records raw samples, complete identity, and exact summaries', async () => {
    const report = await runBenchmark({
      iterations: 50,
      warmup: 10,
      clock: deterministicClock(),
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'measured',
      parameters: { iterations: 50, warmup: 10, contention: 64 },
      environment: {
        node: expect.any(String),
        platform: expect.any(String),
        arch: expect.any(String),
        cpuModel: expect.any(String),
        cpuCount: expect.any(Number),
        pluginVersion: '0.1.0-rc.1',
        dshPackageVersion: '0.1.0-rc.6',
        storage: 'in-memory-instrumented',
      },
    })

    for (const measured of Object.values(report.cases)) {
      expect(measured.samples).toHaveLength(50)
      expect(measured.samples.every(sample => sample === 100)).toBe(true)
      expect(measured.summary.p95).toBe(percentile(measured.samples, 0.95))
      expect(JSON.stringify(measured).indexOf('samples'))
        .toBeLessThan(JSON.stringify(measured).indexOf('summary'))
    }

    expect(report.operationBudgets).toMatchObject({
      denied: { accepted: 0, denied: 50, ledgerWrites: 0 },
      acceptedNew: { accepted: 50, denied: 0, ledgerWrites: 50 },
      coldResume: { accepted: 50, denied: 0, ledgerWrites: 0 },
      releaseAfterCleanup: { releases: 50, ledgerWrites: 0 },
      snapshotGet: { ledgerWrites: 0 },
      snapshotWatch: { ledgerWrites: 0 },
      concurrentReserve64: {
        batches: 50,
        attemptedPerBatch: 64,
        acceptedPerBatch: 6,
        deniedPerBatch: 58,
        ledgerWritesPerBatch: 6,
      },
    })
  })

  it('reproduces measured case data when the measurement clock is controlled', async () => {
    const options = { iterations: 3, warmup: 1 }
    const first = await runBenchmark({ ...options, clock: deterministicClock(7n) })
    const second = await runBenchmark({ ...options, clock: deterministicClock(7n) })

    expect(second.cases).toEqual(first.cases)
    expect(second.operationBudgets).toEqual(first.operationBudgets)
  })

  it('uses nearest-rank percentiles over sorted raw values', () => {
    expect(percentile([30, 10, 20, 50, 40], 0.5)).toBe(30)
    expect(percentile([30, 10, 20, 50, 40], 0.95)).toBe(50)
    expect(() => percentile([], 0.95)).toThrow('non-empty')
  })
})

describe('Discussion 131 safe workload', () => {
  it('bounds a nested 56-child shape in Strict without starting denied providers', async () => {
    const report = await runReproduction131({ strictOnly: true })

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'measured',
      shape: {
        requestedChildren: 56,
        topology: 'binary-nested',
        operation: 'new-continuable',
        scheduling: 'background',
        externalModelCalls: 0,
      },
      safety: {
        stockStressAuthorized: false,
        stockStressExecuted: false,
      },
      strict: {
        mode: 'strict',
        enforced: true,
        requestedChildren: 56,
        policyAttempts: 9,
        accepted: 4,
        denied: 5,
        suppressedDescendants: 47,
        providerStarts: 4,
        peakGlobalActive: 4,
        peakRootActive: 4,
        sessionWrites: 32,
        journalFiles: 4,
        journalBytes: expect.any(Number),
        sessionWriteSurface: 'filesystem-jsonl-fixture',
        deniedByCode: { ROOT_ACTIVE_LIMIT: 5 },
        globalProbe: {
          attempted: 7,
          accepted: 6,
          deniedCode: 'GLOBAL_ACTIVE_LIMIT',
          providerStarts: 6,
        },
      },
    })
    expect(report.stock).toBeUndefined()
  })

  it('refuses the stock workload without the explicit stress flag', async () => {
    await expect(runReproduction131({ strictOnly: false }))
      .rejects.toThrow('--allow-stock-stress')
  })

  it('runs opted-in stock Audit in a timed, memory-capped child process', async () => {
    const temporaryRootsBefore = reproductionTempRoots()
    const report = await runReproduction131({
      strictOnly: false,
      allowStockStress: true,
      requestedChildren: 8,
      sessionWritesPerChild: 2,
      stockTimeoutMs: 5_000,
      stockOldSpaceMib: 64,
    })

    expect(report.stock).toMatchObject({
      mode: 'audit',
      enforced: false,
      attempted: 8,
      accepted: 8,
      denied: 0,
      providerStarts: 8,
      peakGlobalActive: 8,
      sessionWrites: 16,
      journalFiles: 8,
      journalBytes: expect.any(Number),
      sessionWriteSurface: 'filesystem-jsonl-fixture',
      worker: {
        timedOut: false,
        exitCode: 0,
        timeoutMs: 5_000,
        v8OldSpaceMib: 64,
      },
    })
    expect(report.safety).toMatchObject({
      stockStressAuthorized: true,
      stockStressExecuted: true,
    })
    expect(report.stock!.journalBytes).toBeGreaterThan(0)
    expect(reproductionTempRoots()).toEqual(temporaryRootsBefore)
  }, 15_000)
})
