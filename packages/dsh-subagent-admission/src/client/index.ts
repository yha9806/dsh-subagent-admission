/** Client entry for the dsh-subagent-admission dual-face plugin. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import snapshotRemote from 'dsh-subagent-admission/remote'

import { AdmissionSnapshotController } from './controller.js'

export { AdmissionSnapshotController } from './controller.js'
export type {
  AdmissionControllerInjection,
  AdmissionSnapshotRemote,
} from './controller.js'

/** Stable plugin identity for the client module loader. */
export const name = 'dsh-subagent-admission'

/** Required Client services for Remote lifecycle and the next native-view task. */
export const inject = ['remote', 'slots', 'locale', 'sessions']

/** Mount the generated read-only Remote and own the controller lifecycle. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(snapshotRemote)
  const controller = new AdmissionSnapshotController(ctx.remote.snapshot)
  return async () => {
    controller.stop()
    await disposeRemote()
  }
}
