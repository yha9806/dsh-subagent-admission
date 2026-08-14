/** Package/runtime constants safe to inspect without starting the plugin. */

/** Stable package identity for runtime attestation. */
export const PACKAGE_ID = 'dsh-subagent-admission' as const

/** The only official admission seam protocol this release can enforce. */
export const SUPPORTED_ADMISSION_PROTOCOL_VERSION = 1 as const
