import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

import type {
  AdmissionSnapshot,
  SnapshotGetRequest,
  SnapshotWatchRequest,
} from '../types.js'

/** Host wait used for every generated `snapshot.watch` request. */
export const WATCH_TIMEOUT_MS = 25_000 as const

/** Bounded retry schedule for transport and Remote-result failures. */
export const RETRY_BACKOFF_MS = Object.freeze([250, 500, 1_000, 2_000, 5_000])

/** Narrow generated Remote surface consumed by the controller. */
export interface AdmissionSnapshotRemote {
  get(request: SnapshotGetRequest): Promise<RemoteResult<AdmissionSnapshot>>
  watch(
    request: SnapshotWatchRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<AdmissionSnapshot>>
}

export interface AdmissionControllerInjection {
  readonly hooks: {
    readonly admission: AdmissionSnapshotController
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function isSnapshotForSession(
  snapshot: AdmissionSnapshot,
  sessionId: string,
): boolean {
  return snapshot.schemaVersion === 1
    && snapshot.requestedSessionId === sessionId
    && snapshot.epoch.length > 0
    && Number.isSafeInteger(snapshot.revision)
    && snapshot.revision >= 0
}

/**
 * One-session full-snapshot store for the read-only native Client view.
 *
 * A generation token rejects every response owned by an earlier session or a
 * stopped controller. The Remote codec validates payload shape; this class
 * additionally pins each decoded snapshot to the session that requested it.
 */
export class AdmissionSnapshotController {
  private readonly listeners = new Set<() => void>()
  private current: AdmissionSnapshot | null = null
  private activeSessionId: string | null = null
  private activeAbort: AbortController | null = null
  private generation = 0

  constructor(private readonly remote: AdmissionSnapshotRemote) {}

  /** Stable useSyncExternalStore-compatible snapshot reader. */
  readonly getSnapshot = (): AdmissionSnapshot | null => this.current

  /** Stable useSyncExternalStore-compatible subscription source. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Start or switch the one active long-poll loop. Repeating one session is a no-op. */
  start(sessionId: string): void {
    if (sessionId.length === 0) throw new Error('admission snapshot sessionId must not be empty')
    if (this.activeSessionId === sessionId && this.activeAbort?.signal.aborted === false) return

    this.cancelActive()
    this.replace(null)
    this.activeSessionId = sessionId
    const abort = new AbortController()
    this.activeAbort = abort
    const generation = this.generation
    void this.poll(sessionId, generation, abort.signal)
  }

  /** Start/switch and expose this controller through the native slot hook face. */
  inject(sessionId: string): AdmissionControllerInjection {
    this.start(sessionId)
    return { hooks: { admission: this } }
  }

  /** Abort the active watch, invalidate pending reads/retries, and clear stale state. */
  stop(): void {
    this.cancelActive()
    this.replace(null)
  }

  private cancelActive(): void {
    this.generation += 1
    this.activeSessionId = null
    this.activeAbort?.abort()
    this.activeAbort = null
  }

  private isCurrent(sessionId: string, generation: number, signal: AbortSignal): boolean {
    return !signal.aborted
      && this.generation === generation
      && this.activeSessionId === sessionId
  }

  private async poll(
    sessionId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor: AdmissionSnapshot | null = null
    let failures = 0

    while (this.isCurrent(sessionId, generation, signal)) {
      try {
        const result: RemoteResult<AdmissionSnapshot> = cursor === null
          ? await this.remote.get({ sessionId })
          : await this.remote.watch({
              sessionId,
              epoch: cursor.epoch,
              revision: cursor.revision,
              timeoutMs: WATCH_TIMEOUT_MS,
            }, signal)
        if (!this.isCurrent(sessionId, generation, signal)) return
        if (!result.ok || !isSnapshotForSession(result.value, sessionId)) {
          throw new Error(result.ok
            ? 'admission snapshot response does not match its requested session'
            : `${result.error.code}: ${result.error.message}`)
        }

        cursor = result.value
        failures = 0
        this.replace(cursor)
      } catch {
        if (!this.isCurrent(sessionId, generation, signal)) return
        const delay = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)]!
        failures += 1
        await waitForRetry(delay, signal)
      }
    }
  }

  private replace(next: AdmissionSnapshot | null): void {
    if (Object.is(this.current, next)) return
    this.current = next
    /* oxlint-disable-next-line unicorn/no-useless-spread -- freeze this delivery's
     * recipients when a listener subscribes or unsubscribes during notification. */
    for (const listener of [...this.listeners]) listener()
  }
}
