/**
 * Package/runtime invariant companion (Task 1 stub).
 *
 * Functional invariant assertions and the package identity gate land with the
 * admission kernel in later tasks; this module exists now so the packed
 * artifact ships the same face the official DSH packages export.
 */

/** Stable package identity for runtime attestation. */
export const PACKAGE_ID = 'dsh-subagent-admission' as const
