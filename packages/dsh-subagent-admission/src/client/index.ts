/** Client entry for the dsh-subagent-admission dual-face plugin. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import snapshotRemote from 'dsh-subagent-admission/remote'

import { AdmissionControlView } from './AdmissionControlView.js'
import { AdmissionSnapshotController } from './controller.js'
import type { AdmissionControllerInjection } from './controller.js'
import { en, NS, zh } from './locales.js'
import { ensureAdmissionStyles } from './styles.js'

export { AdmissionSnapshotController } from './controller.js'
export type {
  AdmissionControllerInjection,
  AdmissionSnapshotRemote,
} from './controller.js'

/** Stable plugin identity for the client module loader. */
export const name = 'dsh-subagent-admission'

/** Required Client services for Remote lifecycle and the native conversation view. */
export const inject = ['remote', 'slots', 'locale', 'sessions']

/** Services read only after this package's generated Remote contribution mounts. */
const SNAPSHOT_FEATURE_INJECT = [
  'remote.snapshot',
  'slots',
  'locale',
  'sessions',
] as const

type Disposer = () => void | Promise<void>

async function disposeReverse(disposers: readonly Disposer[]): Promise<void> {
  const errors: unknown[] = []
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Admission Control cleanup failed')
}

/** Register the controller and native view inside an endpoint-authorized child fiber. */
async function mountSnapshotFeature(
  ctx: ClientContext,
): Promise<() => Promise<void>> {
  const disposers: Disposer[] = []
  try {
    const controller = new AdmissionSnapshotController(ctx.remote.snapshot)
    disposers.push(() => { controller.stop() })

    disposers.push(ctx.locale.register(NS, { zh, en }))
    disposers.push(ensureAdmissionStyles())
    const t = ctx.locale.bind(NS)
    disposers.push(ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: 'admission-control',
      order: 20,
      locale: NS,
      label: () => t('view.label'),
      inject: (sessionId: SessionId): AdmissionControllerInjection => controller.inject(sessionId),
    }, AdmissionControlView)))
  } catch (setupError) {
    try {
      await disposeReverse(disposers)
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        'Admission Control setup and rollback failed',
      )
    }
    throw setupError
  }

  let active = true
  return async () => {
    if (!active) return
    active = false
    await disposeReverse(disposers)
  }
}

/** Mount Remote first, then authorize its endpoint before any property read. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(snapshotRemote)
  const feature = ctx.inject(
    [...SNAPSHOT_FEATURE_INJECT],
    (scope: ClientContext) => mountSnapshotFeature(scope),
  )
  try {
    await feature.await()
  } catch (setupError) {
    const cleanupErrors: unknown[] = []
    await feature.dispose().catch(error => cleanupErrors.push(error))
    await disposeRemote().catch(error => cleanupErrors.push(error))
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        'Admission Control setup and rollback failed',
      )
    }
    throw setupError
  }

  let active = true
  return async () => {
    if (!active) return
    active = false
    const errors: unknown[] = []
    await feature.dispose().catch(error => errors.push(error))
    await disposeRemote().catch(error => errors.push(error))
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Admission Control cleanup failed')
    }
  }
}
