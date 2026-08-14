/**
 * Public wire vocabulary shared by the Host and Client faces.
 *
 * Task 2A declares the readonly plain-data admission vocabulary. Keeping this
 * module import-free guarantees the Client bundle stays browser-safe. It
 * carries only operational identifiers and counters; prompts, messages, tool
 * arguments, model output, credentials, and stacks never appear here.
 */

/** Schema version of the shared admission wire vocabulary. */
export const WIRE_SCHEMA_VERSION = 1 as const

/** Schema version of AdmissionSnapshot payloads. */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const

/** Maximum number of admission history events retained in one snapshot. */
export const MAX_HISTORY_EVENTS = 200 as const

export type AdmissionOperation = 'new-one-shot' | 'new-continuable' | 'cold-resume'

export type AdmissionMode = 'strict' | 'audit' | 'unavailable' | 'draining'

export interface AdmissionLimits {
  readonly globalActive: number
  readonly perRootActive: number
  readonly perRootAdmittedTotal: number
  readonly perParentChildren: number
}

export interface SnapshotGetRequest {
  readonly sessionId: string
}

export interface SnapshotWatchRequest {
  readonly sessionId: string
  readonly epoch: string | null
  readonly revision: number
  readonly timeoutMs: number
}

export interface AdmissionUsage {
  readonly globalActive: number
  readonly rootActive: number
  readonly rootAdmittedTotal: number
  readonly parentChildren: number
}

export type AdmissionLeasePhase = 'active' | 'draining'

export interface AdmissionLease {
  /** Null while a one-shot provider has not yet published its child identity. */
  readonly childSessionId: string | null
  readonly parentSessionId: string
  readonly rootId: string
  readonly operation: AdmissionOperation
  readonly mode: AdmissionMode
  readonly admittedAt: string
  readonly phase: AdmissionLeasePhase
}

export type AdmissionEventKind =
  | 'accepted'
  | 'denied'
  | 'released'
  | 'failed-start'
  | 'protocol'
  | 'bootstrap'

export interface AdmissionEvent {
  readonly kind: AdmissionEventKind
  readonly time: string
  readonly requestId: string | null
  readonly operation: AdmissionOperation | null
  readonly rootId: string | null
  readonly parentSessionId: string | null
  readonly code: string | null
}

export interface AdmissionSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  readonly time: string
  readonly epoch: string
  readonly revision: number
  readonly requestedSessionId: string
  readonly requestedRootId: string | null
  readonly mode: AdmissionMode
  /** True only when this snapshot describes protocol-backed enforcement. */
  readonly enforced: boolean
  readonly reason: string | null
  readonly limits: AdmissionLimits
  readonly usage: AdmissionUsage
  readonly leases: readonly AdmissionLease[]
  readonly history: readonly AdmissionEvent[]
  readonly droppedHistory: number
}
