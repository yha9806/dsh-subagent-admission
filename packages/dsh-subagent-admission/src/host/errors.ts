import type { AdmissionOperation } from '../types.js'

/**
 * The public, stable admission error vocabulary. Exactly eight codes; the
 * permanent cumulative failures precede the transient active failures in
 * diagnostic order, but the record itself is an unordered stable set.
 */
export const ADMISSION_ERROR_CODES = {
  ADMISSION_UNAVAILABLE: 'ADMISSION_UNAVAILABLE',
  ADMISSION_CLOSED: 'ADMISSION_CLOSED',
  ADMISSION_STATE_IO: 'ADMISSION_STATE_IO',
  ADMISSION_BINDING_CONFLICT: 'ADMISSION_BINDING_CONFLICT',
  ROOT_TOTAL_LIMIT: 'ROOT_TOTAL_LIMIT',
  PARENT_CHILD_LIMIT: 'PARENT_CHILD_LIMIT',
  ROOT_ACTIVE_LIMIT: 'ROOT_ACTIVE_LIMIT',
  GLOBAL_ACTIVE_LIMIT: 'GLOBAL_ACTIVE_LIMIT',
} as const

export type AdmissionErrorCode =
  (typeof ADMISSION_ERROR_CODES)[keyof typeof ADMISSION_ERROR_CODES]

/**
 * Detached denial metadata for diagnosis. Contains only operational
 * identifiers and counters; it never carries prompts, messages, tool
 * arguments, model output, secrets, or provider credentials.
 */
export interface AdmissionDenied {
  readonly code: AdmissionErrorCode
  readonly operation: AdmissionOperation
  readonly rootId: string
  readonly parentId: string | null
  readonly observedValue: number
  readonly limit: number
  readonly policyEpoch: string
  readonly requestId: string
}

export interface AdmissionDeniedInput {
  readonly code: AdmissionErrorCode
  readonly operation: AdmissionOperation
  readonly rootId: string
  readonly parentId: string | null
  readonly observedValue: number
  readonly limit: number
  readonly policyEpoch: string
  readonly requestId: string
}

/**
 * Builds a frozen, prototype-less denial snapshot that copies only the
 * allowed fields. Extra properties on the input are dropped, so sensitive
 * caller data can never ride along on a denial.
 */
export function createAdmissionDenied(
  input: AdmissionDeniedInput,
): AdmissionDenied {
  const record: Record<string, unknown> = Object.assign(Object.create(null), {
    code: input.code,
    operation: input.operation,
    rootId: input.rootId,
    parentId: input.parentId,
    observedValue: input.observedValue,
    limit: input.limit,
    policyEpoch: input.policyEpoch,
    requestId: input.requestId,
  })
  return Object.freeze(record) as unknown as AdmissionDenied
}
