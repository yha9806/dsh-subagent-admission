/** Host entry for the lifecycle-safe DSH subagent admission plugin. */

import type { Context } from '@deepseek-ai/cordis'

import type { ConfigInput } from './host/config.js'
import { createSubagentAdmissionService } from './host/service.js'

/** Stable plugin identity used by the Cordis loader and bundle patch rows. */
export const name = 'dsh-subagent-admission'

/**
 * Required stock services. `storageDomain` is deliberately optional here:
 * Audit must still mount without it, while Strict reports Unavailable.
 */
export const inject = ['subagents', 'sessions', 'sessionPersistence']

export { Config, resolveConfig } from './host/config.js'
export type { ConfigInput } from './host/config.js'
export { SubagentAdmissionService } from './host/service.js'
export type * from './types.js'

/**
 * Compose the Host service and return its ordered asynchronous disposer to
 * Cordis. Strict incompatibility is a live Unavailable service, not a plugin
 * startup crash; malformed user configuration still fails normally.
 */
export async function apply(
  ctx: Context,
  config: ConfigInput = {},
): Promise<() => Promise<void>> {
  const service = await createSubagentAdmissionService(ctx, config)
  return (): Promise<void> => service.dispose()
}
