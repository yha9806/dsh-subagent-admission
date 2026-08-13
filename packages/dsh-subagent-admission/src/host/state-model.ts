import type {
  AdmissionLimits,
  AdmissionOperation,
} from '../types.js'

import {
  ADMISSION_ERROR_CODES,
  createAdmissionDenied,
  type AdmissionDenied,
  type AdmissionErrorCode,
} from './errors.js'

/**
 * Pure, deterministic admission state machine for Task 2B.
 *
 * Every function here is a referentially transparent transition over
 * immutable data. There is no I/O, no clock, no provider, no persistence, no
 * runtime, and no module-level mutable state. Caller-owned maps are never
 * mutated: every state change clones the affected maps first, and the
 * boundary types are `ReadonlyMap`.
 */

/** Lifecycle of the admission authority itself. */
export type AdmissionLifecycle = 'open' | 'draining'

/** One live admission activation. */
export interface AdmissionPermit {
  readonly permitId: string
  readonly rootId: string
  readonly parentId: string
  readonly operation: AdmissionOperation
  readonly childId: string | null
}

/**
 * Immutable admission state.
 *
 * `globalActive` always equals `permits.size` and the sum of all
 * `rootActive` counts. Cumulative counters (`rootAdmittedTotal`,
 * `parentChildren`) are never refunded by release or restart.
 */
export interface AdmissionState {
  readonly limits: AdmissionLimits
  readonly lifecycle: AdmissionLifecycle
  readonly globalActive: number
  readonly rootActive: ReadonlyMap<string, number>
  readonly rootAdmittedTotal: ReadonlyMap<string, number>
  readonly parentChildren: ReadonlyMap<string, number>
  readonly permits: ReadonlyMap<string, AdmissionPermit>
  /** Monotonic source of unique permit ids; survives restart. */
  readonly permitCounter: number
}

export interface NewAdmissionCommand {
  readonly kind: 'new-admission'
  readonly operation: 'new-one-shot' | 'new-continuable'
  readonly rootId: string
  readonly parentId: string
  readonly requestId: string
  readonly policyEpoch: string
  /** Injected persistence failure; denies the admission without changes. */
  readonly ledgerFailure?: boolean
}

export interface ColdResumeCommand {
  readonly kind: 'cold-resume'
  readonly rootId: string
  readonly parentId: string
  readonly requestId: string
  readonly policyEpoch: string
}

export interface ResidentFollowUpCommand {
  readonly kind: 'resident-follow-up'
}

export interface BindCommand {
  readonly kind: 'bind'
  readonly permitId: string
  readonly childId: string
  readonly requestId: string
  readonly policyEpoch: string
}

export interface ReleaseCommand {
  readonly kind: 'release'
  readonly permitId: string
}

export interface UnloadCommand {
  readonly kind: 'unload'
}

export interface RestartCommand {
  readonly kind: 'restart'
}

export type AdmissionCommand =
  | NewAdmissionCommand
  | ColdResumeCommand
  | ResidentFollowUpCommand
  | BindCommand
  | ReleaseCommand
  | UnloadCommand
  | RestartCommand

export interface AdmissionAcceptedTransition {
  readonly status: 'accepted'
  readonly state: AdmissionState
  /** The created, bound, or released permit; null for unload/restart. */
  readonly permit: AdmissionPermit | null
}

export interface AdmissionAcknowledgedTransition {
  readonly status: 'acknowledged'
  /** Always the same reference as the input: a semantic no-op. */
  readonly state: AdmissionState
}

export interface AdmissionDeniedTransition {
  readonly status: 'denied'
  /** Always the same reference as the input: nothing was mutated. */
  readonly state: AdmissionState
  readonly denial: AdmissionDenied
}

export type AdmissionTransition =
  | AdmissionAcceptedTransition
  | AdmissionAcknowledgedTransition
  | AdmissionDeniedTransition

export type CountMapInput =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>
  | readonly (readonly [string, number])[]

export interface CreateAdmissionStateInput {
  readonly limits: AdmissionLimits
  readonly lifecycle?: AdmissionLifecycle
  readonly rootAdmittedTotal?: CountMapInput
  readonly parentChildren?: CountMapInput
  readonly permitCounter?: number
}

/**
 * Builds a fresh open state with zero active counts and empty permits.
 * Cumulative inputs are copied into new maps so later transitions can never
 * mutate caller-owned data.
 */
export function createAdmissionState(
  input: CreateAdmissionStateInput,
): AdmissionState {
  return {
    limits: { ...input.limits },
    lifecycle: input.lifecycle ?? 'open',
    globalActive: 0,
    rootActive: new Map(),
    rootAdmittedTotal: toCountMap(input.rootAdmittedTotal),
    parentChildren: toCountMap(input.parentChildren),
    permits: new Map(),
    permitCounter: input.permitCounter ?? 0,
  }
}

/**
 * Applies one command and returns the outcome plus the next state.
 *
 * Denials and acknowledged no-ops return the exact input state reference.
 * Accepted transitions return a fresh state; maps are cloned before any
 * mutation.
 */
export function transitionModel(
  state: AdmissionState,
  command: AdmissionCommand,
): AdmissionTransition {
  switch (command.kind) {
    case 'new-admission':
      return transitionNewAdmission(state, command)
    case 'cold-resume':
      return transitionColdResume(state, command)
    case 'resident-follow-up':
      return { status: 'acknowledged', state }
    case 'bind':
      return transitionBind(state, command)
    case 'release':
      return transitionRelease(state, command)
    case 'unload':
      return transitionUnload(state)
    case 'restart':
      return transitionRestart(state)
  }
}

function transitionNewAdmission(
  state: AdmissionState,
  command: NewAdmissionCommand,
): AdmissionTransition {
  if (state.lifecycle !== 'open') {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ADMISSION_CLOSED,
      command.operation,
      command.rootId,
      command.parentId,
      0,
      0,
      command.requestId,
      command.policyEpoch,
    )
  }
  const limits = state.limits
  const rootTotal = state.rootAdmittedTotal.get(command.rootId) ?? 0
  if (rootTotal >= limits.perRootAdmittedTotal) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ROOT_TOTAL_LIMIT,
      command.operation,
      command.rootId,
      command.parentId,
      rootTotal,
      limits.perRootAdmittedTotal,
      command.requestId,
      command.policyEpoch,
    )
  }
  const parentChildren = state.parentChildren.get(command.parentId) ?? 0
  if (parentChildren >= limits.perParentChildren) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.PARENT_CHILD_LIMIT,
      command.operation,
      command.rootId,
      command.parentId,
      parentChildren,
      limits.perParentChildren,
      command.requestId,
      command.policyEpoch,
    )
  }
  const rootActive = state.rootActive.get(command.rootId) ?? 0
  if (rootActive >= limits.perRootActive) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ROOT_ACTIVE_LIMIT,
      command.operation,
      command.rootId,
      command.parentId,
      rootActive,
      limits.perRootActive,
      command.requestId,
      command.policyEpoch,
    )
  }
  if (state.globalActive >= limits.globalActive) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.GLOBAL_ACTIVE_LIMIT,
      command.operation,
      command.rootId,
      command.parentId,
      state.globalActive,
      limits.globalActive,
      command.requestId,
      command.policyEpoch,
    )
  }
  if (command.ledgerFailure === true) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ADMISSION_STATE_IO,
      command.operation,
      command.rootId,
      command.parentId,
      0,
      0,
      command.requestId,
      command.policyEpoch,
    )
  }
  return activate(state, command.operation, command.rootId, command.parentId, true)
}

function transitionColdResume(
  state: AdmissionState,
  command: ColdResumeCommand,
): AdmissionTransition {
  if (state.lifecycle !== 'open') {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ADMISSION_CLOSED,
      'cold-resume',
      command.rootId,
      command.parentId,
      0,
      0,
      command.requestId,
      command.policyEpoch,
    )
  }
  const rootActive = state.rootActive.get(command.rootId) ?? 0
  if (rootActive >= state.limits.perRootActive) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ROOT_ACTIVE_LIMIT,
      'cold-resume',
      command.rootId,
      command.parentId,
      rootActive,
      state.limits.perRootActive,
      command.requestId,
      command.policyEpoch,
    )
  }
  if (state.globalActive >= state.limits.globalActive) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.GLOBAL_ACTIVE_LIMIT,
      'cold-resume',
      command.rootId,
      command.parentId,
      state.globalActive,
      state.limits.globalActive,
      command.requestId,
      command.policyEpoch,
    )
  }
  return activate(state, 'cold-resume', command.rootId, command.parentId, false)
}

function transitionBind(
  state: AdmissionState,
  command: BindCommand,
): AdmissionTransition {
  const permit = state.permits.get(command.permitId)
  if (permit === undefined) {
    // No permit to attach to, and no honest operation metadata exists for a
    // missing permit, so this is a silent no-op rather than a denial.
    return { status: 'acknowledged', state }
  }
  if (permit.childId === command.childId) {
    return { status: 'acknowledged', state }
  }
  if (permit.childId !== null) {
    return deny(
      state,
      ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT,
      permit.operation,
      permit.rootId,
      permit.parentId,
      1,
      1,
      command.requestId,
      command.policyEpoch,
    )
  }
  const bound: AdmissionPermit = { ...permit, childId: command.childId }
  const permits = new Map(state.permits)
  permits.set(permit.permitId, bound)
  return {
    status: 'accepted',
    state: { ...state, permits },
    permit: bound,
  }
}

function transitionRelease(
  state: AdmissionState,
  command: ReleaseCommand,
): AdmissionTransition {
  const permit = state.permits.get(command.permitId)
  if (permit === undefined) {
    return { status: 'acknowledged', state }
  }
  const permits = new Map(state.permits)
  permits.delete(permit.permitId)
  const rootActive = new Map(state.rootActive)
  const rootCount = rootActive.get(permit.rootId) ?? 0
  if (rootCount > 1) {
    rootActive.set(permit.rootId, rootCount - 1)
  } else {
    rootActive.delete(permit.rootId)
  }
  return {
    status: 'accepted',
    state: {
      ...state,
      globalActive: state.globalActive - 1,
      rootActive,
      permits,
    },
    permit,
  }
}

function transitionUnload(state: AdmissionState): AdmissionTransition {
  if (state.lifecycle === 'draining') {
    return { status: 'acknowledged', state }
  }
  return {
    status: 'accepted',
    state: { ...state, lifecycle: 'draining' },
    permit: null,
  }
}

function transitionRestart(state: AdmissionState): AdmissionTransition {
  return {
    status: 'accepted',
    state: {
      limits: state.limits,
      lifecycle: 'open',
      globalActive: 0,
      rootActive: new Map(),
      rootAdmittedTotal: new Map(state.rootAdmittedTotal),
      parentChildren: new Map(state.parentChildren),
      permits: new Map(),
      permitCounter: state.permitCounter,
    },
    permit: null,
  }
}

function activate(
  state: AdmissionState,
  operation: AdmissionOperation,
  rootId: string,
  parentId: string,
  cumulative: boolean,
): AdmissionAcceptedTransition {
  const permit: AdmissionPermit = {
    permitId: `permit-${String(state.permitCounter)}`,
    rootId,
    parentId,
    operation,
    childId: null,
  }
  const permits = new Map(state.permits)
  permits.set(permit.permitId, permit)
  const rootActive = incrementCount(state.rootActive, rootId)
  return {
    status: 'accepted',
    state: {
      limits: state.limits,
      lifecycle: state.lifecycle,
      globalActive: state.globalActive + 1,
      rootActive,
      rootAdmittedTotal: cumulative
        ? incrementCount(state.rootAdmittedTotal, rootId)
        : new Map(state.rootAdmittedTotal),
      parentChildren: cumulative
        ? incrementCount(state.parentChildren, parentId)
        : new Map(state.parentChildren),
      permits,
      permitCounter: state.permitCounter + 1,
    },
    permit,
  }
}

function incrementCount(
  source: ReadonlyMap<string, number>,
  key: string,
): Map<string, number> {
  const next = new Map(source)
  next.set(key, (next.get(key) ?? 0) + 1)
  return next
}

function deny(
  state: AdmissionState,
  code: AdmissionErrorCode,
  operation: AdmissionOperation,
  rootId: string,
  parentId: string | null,
  observedValue: number,
  limit: number,
  requestId: string,
  policyEpoch: string,
): AdmissionDeniedTransition {
  return {
    status: 'denied',
    state,
    denial: createAdmissionDenied({
      code,
      operation,
      rootId,
      parentId,
      observedValue,
      limit,
      policyEpoch,
      requestId,
    }),
  }
}

function toCountMap(input: CountMapInput | undefined): Map<string, number> {
  if (input === undefined) {
    return new Map()
  }
  if (input instanceof Map) {
    return new Map(input)
  }
  if (Array.isArray(input)) {
    return new Map(input)
  }
  return new Map(Object.entries(input))
}
