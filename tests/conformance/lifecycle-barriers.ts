/** Deterministic lifecycle barriers shared by direct-service and tool fixtures. */

export type LifecycleBarrierName =
  | 'beforeProvider'
  | 'beforeMaterialize'
  | 'resultSettled'
  | 'beforeDisposeComplete'
  | 'descendantHeld'
  | 'finishDisposalComplete'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export class LifecycleBarrier {
  private readonly arrived = deferred<void>()
  private readonly opened = deferred<void>()
  private didArrive = false
  private didOpen = false

  readonly reached = this.arrived.promise

  constructor(readonly name: LifecycleBarrierName) {}

  /** Mark the edge reached and wait until the test opens it. */
  async hold(): Promise<void> {
    this.mark()
    await this.opened.promise
  }

  /** Mark an observation-only edge without blocking it. */
  mark(): void {
    if (this.didArrive) return
    this.didArrive = true
    this.arrived.resolve(undefined)
  }

  /** Release a blocking edge. Safe to repeat during fixture cleanup. */
  open(): void {
    if (this.didOpen) return
    this.didOpen = true
    this.opened.resolve(undefined)
  }

  get reachedNow(): boolean {
    return this.didArrive
  }
}

export interface LifecycleBarriers {
  readonly beforeProvider: LifecycleBarrier
  readonly beforeMaterialize: LifecycleBarrier
  readonly resultSettled: LifecycleBarrier
  readonly beforeDisposeComplete: LifecycleBarrier
  readonly descendantHeld: LifecycleBarrier
  readonly finishDisposalComplete: LifecycleBarrier
}

export function createLifecycleBarriers(): LifecycleBarriers {
  return Object.freeze({
    beforeProvider: new LifecycleBarrier('beforeProvider'),
    beforeMaterialize: new LifecycleBarrier('beforeMaterialize'),
    resultSettled: new LifecycleBarrier('resultSettled'),
    beforeDisposeComplete: new LifecycleBarrier('beforeDisposeComplete'),
    descendantHeld: new LifecycleBarrier('descendantHeld'),
    finishDisposalComplete: new LifecycleBarrier('finishDisposalComplete'),
  })
}

export function openAllBarriers(barriers: LifecycleBarriers): void {
  for (const barrier of Object.values(barriers)) barrier.open()
}
