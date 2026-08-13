/**
 * Public wire vocabulary shared by the Host and Client faces.
 *
 * Task 1 declares the schema version contract only; the Client-safe
 * Remote/snapshot vocabulary (AdmissionSnapshot, denial codes) arrives in
 * later tasks. Keeping this module import-free guarantees the Client bundle
 * stays browser-safe.
 */

/** Schema version of the shared admission wire vocabulary. */
export const WIRE_SCHEMA_VERSION = 1 as const
