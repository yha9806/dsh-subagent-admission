import type { SubagentAdmissionPolicyV1 } from './seam-v1.js'

/** User-selectable modes. Runtime-only states are never accepted as config. */
export type ConfiguredAdmissionMode = 'strict' | 'audit'

/** One exact upstream build whose protocol-v1 patch passed verification. */
export interface StrictCompatibilityTarget {
  readonly sourceCommit: string
  readonly sourcePackageVersion: string
  readonly protocolVersion: number
  readonly patchSha256: string
  readonly verificationCommand: string
}

/** Narrow compatibility data embedded into the built Host artifact. */
export interface CompatibilityBaseline {
  readonly schemaVersion: 1
  readonly strictTargets: readonly StrictCompatibilityTarget[]
}

/** Runtime facts that can be attested by the installed package and service. */
export interface CompatibilityRuntime {
  readonly packageVersion: string
  readonly admissionProtocolVersion?: number
  readonly registerAdmissionPolicy?: (
    policy: SubagentAdmissionPolicyV1,
  ) => () => void
}

/** Result of the independent lineage/live-ownership startup scan. */
export interface CompatibilityBootstrap {
  readonly safe: boolean
  readonly reason: string | null
}

export interface CompatibilitySelectionInput {
  readonly configured: ConfiguredAdmissionMode
  readonly runtime: CompatibilityRuntime
  readonly baseline: CompatibilityBaseline
  readonly storageDomainAvailable: boolean
  readonly bootstrap: CompatibilityBootstrap
  readonly ownershipGuardHeld: boolean
}

export interface CompatibilitySelection {
  readonly mode: 'strict' | 'audit' | 'unavailable'
  readonly enforced: boolean
  readonly reason: string | null
  readonly target: StrictCompatibilityTarget | null
}

declare const __DSH_SUBAGENT_ADMISSION_BASELINE__: unknown

const EMPTY_BASELINE: CompatibilityBaseline = Object.freeze({
  schemaVersion: 1,
  strictTargets: Object.freeze([]),
})

/**
 * Read the exact baseline injected by the Host build. Direct source execution
 * (unit tests and editors) falls back to no Strict targets, which is the only
 * fail-closed interpretation when no build attestation is present.
 */
export function embeddedCompatibilityBaseline(): CompatibilityBaseline {
  const raw =
    typeof __DSH_SUBAGENT_ADMISSION_BASELINE__ === 'undefined'
      ? undefined
      : __DSH_SUBAGENT_ADMISSION_BASELINE__
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.strictTargets)) {
    return EMPTY_BASELINE
  }
  const strictTargets = raw.strictTargets
    .filter((target): target is StrictCompatibilityTarget =>
      isRecord(target) && validTarget(target as unknown as StrictCompatibilityTarget),
    )
    .map((target) => Object.freeze({ ...target }))
  return Object.freeze({
    schemaVersion: 1,
    strictTargets: Object.freeze(strictTargets),
  })
}

/**
 * Select the honest runtime mode from explicit facts only.
 *
 * Method presence cannot select a protocol. Audit never registers a policy,
 * even when every Strict prerequisite happens to be present. Strict is an
 * all-or-nothing exact-build claim; every missing fact produces Unavailable.
 */
export function selectAdmissionMode(
  input: CompatibilitySelectionInput,
): CompatibilitySelection {
  if (input.configured === 'audit') {
    return selection('audit', false, 'audit-observation-only', null)
  }

  if (input.runtime.admissionProtocolVersion !== 1) {
    return selection(
      'unavailable',
      false,
      input.runtime.admissionProtocolVersion === undefined
        ? 'admission-seam-unavailable'
        : 'unsupported-admission-protocol',
      null,
    )
  }
  if (typeof input.runtime.registerAdmissionPolicy !== 'function') {
    return selection(
      'unavailable',
      false,
      'admission-seam-unavailable',
      null,
    )
  }

  const target = exactTarget(input.baseline, input.runtime)
  if (target === null) {
    return selection(
      'unavailable',
      false,
      'unsupported-runtime-build',
      null,
    )
  }
  if (!input.storageDomainAvailable) {
    return selection(
      'unavailable',
      false,
      'storage-domain-unavailable',
      target,
    )
  }
  if (!input.bootstrap.safe) {
    return selection(
      'unavailable',
      false,
      safeReason(input.bootstrap.reason, 'unsafe-bootstrap'),
      target,
    )
  }
  if (!input.ownershipGuardHeld) {
    return selection(
      'unavailable',
      false,
      'ownership-guard-unavailable',
      target,
    )
  }
  return selection('strict', true, null, target)
}

function exactTarget(
  baseline: CompatibilityBaseline,
  runtime: CompatibilityRuntime,
): StrictCompatibilityTarget | null {
  if (
    baseline.schemaVersion !== 1 ||
    !Array.isArray(baseline.strictTargets) ||
    runtime.packageVersion.length === 0
  ) {
    return null
  }
  for (const candidate of baseline.strictTargets) {
    if (
      validTarget(candidate) &&
      candidate.sourcePackageVersion === runtime.packageVersion &&
      candidate.protocolVersion === runtime.admissionProtocolVersion
    ) {
      return Object.freeze({ ...candidate })
    }
  }
  return null
}

function validTarget(target: StrictCompatibilityTarget): boolean {
  return (
    typeof target.sourceCommit === 'string' &&
    /^[0-9a-f]{40}$/.test(target.sourceCommit) &&
    typeof target.sourcePackageVersion === 'string' &&
    target.sourcePackageVersion.length > 0 &&
    typeof target.protocolVersion === 'number' &&
    target.protocolVersion === 1 &&
    typeof target.patchSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(target.patchSha256) &&
    typeof target.verificationCommand === 'string' &&
    target.verificationCommand.length > 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selection(
  mode: CompatibilitySelection['mode'],
  enforced: boolean,
  reason: string | null,
  target: StrictCompatibilityTarget | null,
): CompatibilitySelection {
  return Object.freeze({ mode, enforced, reason, target })
}

function safeReason(value: string | null, fallback: string): string {
  return value !== null && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : fallback
}
