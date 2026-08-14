/** Machine-readable Strict/Audit conformance inventory. */

export const CONFORMANCE_CASES = [
  { provider: 'spawn', shape: 'one-shot', scheduling: 'foreground' },
  { provider: 'spawn', shape: 'one-shot', scheduling: 'background' },
  { provider: 'fork', shape: 'one-shot', scheduling: 'foreground' },
  { provider: 'fork', shape: 'one-shot', scheduling: 'background' },
  { provider: 'spawn', shape: 'continuable', scheduling: 'background' },
  { provider: 'fork', shape: 'continuable', scheduling: 'background' },
] as const

export const CONFORMANCE_ENTRY_POINTS = ['direct-service', 'public-tool'] as const

export const REQUIRED_SCENARIOS = [
  'nested-children',
  'ordinary-parent-fork',
  'cold-resume',
  'resident-followup',
  'cancel-before-provider',
  'cancel-after-admission',
  'provider-failure',
  'prepare-failure',
  'materialize-failure',
  'cleanup-delay',
  'cleanup-failure-retains-lease',
  'policy-unload',
  'protocol-mismatch',
  'duplicate-registration',
  'unsafe-bootstrap',
] as const

export type ConformanceCase = (typeof CONFORMANCE_CASES)[number]
export type ConformanceEntryPoint = (typeof CONFORMANCE_ENTRY_POINTS)[number]
export type RequiredScenario = (typeof REQUIRED_SCENARIOS)[number]

export type ConformanceStatus = 'pass' | 'fail' | 'not-applicable'

export interface ConformanceResult {
  readonly id: string
  readonly status: ConformanceStatus
  readonly reason: string | null
  readonly provider: ConformanceCase['provider'] | null
  readonly shape: ConformanceCase['shape'] | null
  readonly scheduling: ConformanceCase['scheduling'] | null
  readonly entryPoint: ConformanceEntryPoint | null
  readonly scenario: RequiredScenario | null
}

export function matrixCaseId(
  candidate: ConformanceCase,
  entryPoint: ConformanceEntryPoint,
): string {
  return [
    'matrix',
    entryPoint,
    candidate.provider,
    candidate.shape,
    candidate.scheduling,
  ].join('/')
}

export function scenarioCaseId(scenario: RequiredScenario): string {
  return `scenario/${scenario}`
}

export const REQUIRED_RESULT_IDS = Object.freeze([
  ...CONFORMANCE_CASES.flatMap((candidate) =>
    CONFORMANCE_ENTRY_POINTS.map((entryPoint) =>
      matrixCaseId(candidate, entryPoint),
    ),
  ),
  ...REQUIRED_SCENARIOS.map(scenarioCaseId),
])
