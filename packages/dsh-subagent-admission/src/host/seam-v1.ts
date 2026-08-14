import type { AdmissionOperation } from '../types.js'

/**
 * Local structural mirror of the official DSH protocol-v1 admission seam.
 *
 * Pure declarations only: no I/O, no provider or prompt surface, no borrowed
 * Agent/AgentHandle objects. The protocol version is the explicit numeric
 * property and is never inferred from method presence.
 */

export interface SubagentAdmissionRequestV1 {
  readonly requestId: string
  readonly operation: AdmissionOperation
  readonly provider: string
  readonly parentSessionId: string
  readonly childSessionId?: string
}

export type SubagentAdmissionReleaseReasonV1 =
  | 'startup-failed'
  | 'quiescent'

export interface SubagentAdmissionPermitV1 {
  bindChild(binding: {
    readonly childSessionId: string
    readonly localParentSessionId?: string
  }): void
  release(reason: SubagentAdmissionReleaseReasonV1): Promise<void>
}

export interface SubagentAdmissionPolicyV1 {
  readonly protocolVersion: 1
  acquire(
    request: Readonly<SubagentAdmissionRequestV1>,
    signal: AbortSignal,
  ): Promise<SubagentAdmissionPermitV1>
}
