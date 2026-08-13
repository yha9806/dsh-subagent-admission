import { describe, expect, it } from 'vitest'

import type { AdmissionLimits } from '../src/types.js'
import { ADMISSION_ERROR_CODES } from '../src/host/errors.js'
import {
  createAdmissionState,
  transitionModel,
  type AdmissionDeniedTransition,
  type AdmissionPermit,
  type AdmissionState,
  type AdmissionTransition,
  type NewAdmissionCommand,
} from '../src/host/state-model.js'

const LIMITS: AdmissionLimits = {
  globalActive: 2,
  perRootActive: 2,
  perRootAdmittedTotal: 3,
  perParentChildren: 3,
}

function newAdmission(
  rootId: string,
  parentId: string,
  requestId: string,
): NewAdmissionCommand {
  return {
    kind: 'new-admission',
    operation: 'new-one-shot',
    rootId,
    parentId,
    requestId,
    policyEpoch: 'epoch-1',
  }
}

function expectAccepted(transition: AdmissionTransition): {
  state: AdmissionState
  permit: AdmissionPermit | null
} {
  expect(transition.status).toBe('accepted')
  if (transition.status !== 'accepted') {
    throw new Error('expected an accepted transition')
  }
  return { state: transition.state, permit: transition.permit }
}

function expectDenied(
  transition: AdmissionTransition,
): AdmissionDeniedTransition {
  expect(transition.status).toBe('denied')
  if (transition.status !== 'denied') {
    throw new Error('expected a denied transition')
  }
  return transition
}

function expectAcknowledged(transition: AdmissionTransition): AdmissionState {
  expect(transition.status).toBe('acknowledged')
  if (transition.status !== 'acknowledged') {
    throw new Error('expected an acknowledged transition')
  }
  return transition.state
}

describe('admission state model (unit)', () => {
  it('admits a new activation by incrementing root total, parent total, and both active counters exactly once', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const first = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const permit1 = first.permit
    expect(permit1).not.toBeNull()
    expect(first.state).not.toBe(initial)
    expect(first.state.globalActive).toBe(1)
    expect(first.state.rootActive.get('root-1')).toBe(1)
    expect(first.state.rootAdmittedTotal.get('root-1')).toBe(1)
    expect(first.state.parentChildren.get('parent-1')).toBe(1)
    expect(first.state.permits.size).toBe(1)
    expect(first.state.permits.get(permit1!.permitId)).toBe(permit1)
    expect(permit1!.operation).toBe('new-one-shot')
    expect(permit1!.childId).toBeNull()

    expect(initial.globalActive).toBe(0)
    expect(initial.rootActive.size).toBe(0)
    expect(initial.rootAdmittedTotal.size).toBe(0)
    expect(initial.parentChildren.size).toBe(0)
    expect(initial.permits.size).toBe(0)

    const second = expectAccepted(
      transitionModel(first.state, {
        kind: 'new-admission',
        operation: 'new-continuable',
        rootId: 'root-1',
        parentId: 'parent-2',
        requestId: 'req-2',
        policyEpoch: 'epoch-1',
      }),
    )
    const permit2 = second.permit
    expect(permit2).not.toBeNull()
    expect(second.state.globalActive).toBe(2)
    expect(second.state.rootActive.get('root-1')).toBe(2)
    expect(second.state.rootAdmittedTotal.get('root-1')).toBe(2)
    expect(second.state.parentChildren.get('parent-1')).toBe(1)
    expect(second.state.parentChildren.get('parent-2')).toBe(1)
    expect(second.state.permits.size).toBe(2)
    expect(permit2!.operation).toBe('new-continuable')
    expect(permit2!.permitId).not.toBe(permit1!.permitId)
  })

  it('cold resume creates an active permit but changes no cumulative count', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const result = expectAccepted(
      transitionModel(initial, {
        kind: 'cold-resume',
        rootId: 'root-1',
        parentId: 'parent-1',
        requestId: 'req-1',
        policyEpoch: 'epoch-1',
      }),
    )
    const permit = result.permit
    expect(permit).not.toBeNull()
    expect(permit!.operation).toBe('cold-resume')
    expect(result.state.globalActive).toBe(1)
    expect(result.state.rootActive.get('root-1')).toBe(1)
    expect(result.state.permits.size).toBe(1)
    expect(result.state.rootAdmittedTotal.size).toBe(0)
    expect(result.state.parentChildren.size).toBe(0)
  })

  it('resident follow-up returns the same semantic state with no permit and no quota change', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const state = expectAcknowledged(
      transitionModel(initial, { kind: 'resident-follow-up' }),
    )
    expect(state).toBe(initial)
    expect(initial.globalActive).toBe(0)
    expect(initial.permits.size).toBe(0)
    expect(initial.rootAdmittedTotal.size).toBe(0)
  })

  it('denies with ROOT_TOTAL_LIMIT when all four limits are hit at once', () => {
    const tight: AdmissionLimits = {
      globalActive: 1,
      perRootActive: 1,
      perRootAdmittedTotal: 1,
      perParentChildren: 1,
    }
    const initial = createAdmissionState({ limits: tight })
    const first = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const denied = expectDenied(
      transitionModel(first.state, newAdmission('root-1', 'parent-1', 'req-2')),
    )
    expect(denied.denial.code).toBe(ADMISSION_ERROR_CODES.ROOT_TOTAL_LIMIT)
    expect(denied.denial.operation).toBe('new-one-shot')
    expect(denied.denial.rootId).toBe('root-1')
    expect(denied.denial.parentId).toBe('parent-1')
    expect(denied.denial.observedValue).toBe(1)
    expect(denied.denial.limit).toBe(1)
    expect(denied.denial.requestId).toBe('req-2')
    expect(denied.denial.policyEpoch).toBe('epoch-1')
    expect(denied.state).toBe(first.state)
    expect(Object.isFrozen(denied.denial)).toBe(true)
    expect(Object.getPrototypeOf(denied.denial)).toBeNull()
  })

  it('evaluates the remaining new-admission limits in the mandated order', () => {
    const parentTight: AdmissionLimits = {
      globalActive: 2,
      perRootActive: 2,
      perRootAdmittedTotal: 2,
      perParentChildren: 1,
    }
    const parentState = expectAccepted(
      transitionModel(
        createAdmissionState({ limits: parentTight }),
        newAdmission('root-1', 'parent-1', 'req-1'),
      ),
    ).state
    const parentDenied = expectDenied(
      transitionModel(parentState, newAdmission('root-2', 'parent-1', 'req-2')),
    )
    expect(parentDenied.denial.code).toBe(
      ADMISSION_ERROR_CODES.PARENT_CHILD_LIMIT,
    )
    expect(parentDenied.denial.observedValue).toBe(1)
    expect(parentDenied.denial.limit).toBe(1)

    const rootActiveTight: AdmissionLimits = {
      globalActive: 2,
      perRootActive: 1,
      perRootAdmittedTotal: 2,
      perParentChildren: 2,
    }
    const rootActiveState = expectAccepted(
      transitionModel(
        createAdmissionState({ limits: rootActiveTight }),
        newAdmission('root-1', 'parent-1', 'req-1'),
      ),
    ).state
    const rootActiveDenied = expectDenied(
      transitionModel(
        rootActiveState,
        newAdmission('root-1', 'parent-2', 'req-2'),
      ),
    )
    expect(rootActiveDenied.denial.code).toBe(
      ADMISSION_ERROR_CODES.ROOT_ACTIVE_LIMIT,
    )

    const globalTight: AdmissionLimits = {
      globalActive: 1,
      perRootActive: 1,
      perRootAdmittedTotal: 2,
      perParentChildren: 2,
    }
    const globalState = expectAccepted(
      transitionModel(
        createAdmissionState({ limits: globalTight }),
        newAdmission('root-1', 'parent-1', 'req-1'),
      ),
    ).state
    const globalDenied = expectDenied(
      transitionModel(globalState, newAdmission('root-2', 'parent-2', 'req-2')),
    )
    expect(globalDenied.denial.code).toBe(
      ADMISSION_ERROR_CODES.GLOBAL_ACTIVE_LIMIT,
    )
    expect(globalDenied.denial.observedValue).toBe(1)
    expect(globalDenied.denial.limit).toBe(1)
  })

  it('binds at most one child, is idempotent, and rejects a different child without mutation', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const admitted = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const permit = admitted.permit!
    const bound = expectAccepted(
      transitionModel(admitted.state, {
        kind: 'bind',
        permitId: permit.permitId,
        childId: 'child-1',
        requestId: 'req-bind',
        policyEpoch: 'epoch-1',
      }),
    )
    expect(bound.permit?.childId).toBe('child-1')
    expect(bound.state.permits.get(permit.permitId)?.childId).toBe('child-1')
    expect(bound.state.globalActive).toBe(admitted.state.globalActive)

    const sameBinding = transitionModel(bound.state, {
      kind: 'bind',
      permitId: permit.permitId,
      childId: 'child-1',
      requestId: 'req-bind-again',
      policyEpoch: 'epoch-1',
    })
    expect(sameBinding.status).toBe('acknowledged')
    expect(sameBinding.state).toBe(bound.state)

    const conflict = expectDenied(
      transitionModel(bound.state, {
        kind: 'bind',
        permitId: permit.permitId,
        childId: 'child-2',
        requestId: 'req-conflict',
        policyEpoch: 'epoch-1',
      }),
    )
    expect(conflict.denial.code).toBe(
      ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT,
    )
    expect(conflict.denial.operation).toBe('new-one-shot')
    expect(conflict.denial.rootId).toBe('root-1')
    expect(conflict.denial.parentId).toBe('parent-1')
    expect(conflict.state).toBe(bound.state)
    expect(bound.state.permits.get(permit.permitId)?.childId).toBe('child-1')

    const unknown = transitionModel(bound.state, {
      kind: 'bind',
      permitId: 'permit-missing',
      childId: 'child-3',
      requestId: 'req-missing',
      policyEpoch: 'epoch-1',
    })
    expect(unknown.status).toBe('acknowledged')
    expect(unknown.state).toBe(bound.state)
  })

  it('release decrements active global and root exactly once and never refunds cumulative counts', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const first = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const second = expectAccepted(
      transitionModel(first.state, newAdmission('root-1', 'parent-1', 'req-2')),
    )
    expect(second.state.globalActive).toBe(2)
    expect(second.state.rootActive.get('root-1')).toBe(2)

    const released = expectAccepted(
      transitionModel(second.state, {
        kind: 'release',
        permitId: first.permit!.permitId,
      }),
    )
    expect(released.permit?.permitId).toBe(first.permit!.permitId)
    expect(released.state.globalActive).toBe(1)
    expect(released.state.rootActive.get('root-1')).toBe(1)
    expect(released.state.permits.size).toBe(1)
    expect(released.state.rootAdmittedTotal.get('root-1')).toBe(2)
    expect(released.state.parentChildren.get('parent-1')).toBe(2)

    const duplicate = transitionModel(released.state, {
      kind: 'release',
      permitId: first.permit!.permitId,
    })
    expect(duplicate.status).toBe('acknowledged')
    expect(duplicate.state).toBe(released.state)
    expect(released.state.globalActive).toBe(1)

    const unknown = transitionModel(released.state, {
      kind: 'release',
      permitId: 'permit-missing',
    })
    expect(unknown.status).toBe('acknowledged')
    expect(unknown.state).toBe(released.state)
  })

  it('unload closes new admissions, keeps existing permits releasable, and stays in draining', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const admitted = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const unloaded = expectAccepted(
      transitionModel(admitted.state, { kind: 'unload' }),
    )
    expect(unloaded.state.lifecycle).toBe('draining')
    expect(unloaded.state.globalActive).toBe(1)

    const newDenied = expectDenied(
      transitionModel(
        unloaded.state,
        newAdmission('root-2', 'parent-2', 'req-2'),
      ),
    )
    expect(newDenied.denial.code).toBe(ADMISSION_ERROR_CODES.ADMISSION_CLOSED)
    expect(newDenied.state).toBe(unloaded.state)

    const coldDenied = expectDenied(
      transitionModel(unloaded.state, {
        kind: 'cold-resume',
        rootId: 'root-2',
        parentId: 'parent-2',
        requestId: 'req-3',
        policyEpoch: 'epoch-1',
      }),
    )
    expect(coldDenied.denial.code).toBe(ADMISSION_ERROR_CODES.ADMISSION_CLOSED)
    expect(coldDenied.state).toBe(unloaded.state)

    const released = expectAccepted(
      transitionModel(unloaded.state, {
        kind: 'release',
        permitId: admitted.permit!.permitId,
      }),
    )
    expect(released.state.lifecycle).toBe('draining')
    expect(released.state.globalActive).toBe(0)
    expect(released.state.permits.size).toBe(0)

    const unloadAgain = transitionModel(unloaded.state, { kind: 'unload' })
    expect(unloadAgain.status).toBe('acknowledged')
    expect(unloadAgain.state).toBe(unloaded.state)
  })

  it('rejects new admissions in a draining state with ADMISSION_CLOSED and no change', () => {
    const draining = createAdmissionState({
      limits: LIMITS,
      lifecycle: 'draining',
    })
    const denied = expectDenied(
      transitionModel(draining, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    expect(denied.denial.code).toBe(ADMISSION_ERROR_CODES.ADMISSION_CLOSED)
    expect(denied.state).toBe(draining)
  })

  it('restart preserves cumulative counts exactly and resets active counts and permits', () => {
    const initial = createAdmissionState({
      limits: LIMITS,
      rootAdmittedTotal: { 'root-0': 5 },
      parentChildren: { 'parent-0': 4 },
    })
    const first = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    const second = expectAccepted(
      transitionModel(first.state, newAdmission('root-2', 'parent-2', 'req-2')),
    )
    const restarted = expectAccepted(
      transitionModel(second.state, { kind: 'restart' }),
    )
    expect(restarted.state.lifecycle).toBe('open')
    expect(restarted.state.globalActive).toBe(0)
    expect(restarted.state.rootActive.size).toBe(0)
    expect(restarted.state.permits.size).toBe(0)
    expect(restarted.state.rootAdmittedTotal).toEqual(
      new Map([
        ['root-0', 5],
        ['root-1', 1],
        ['root-2', 1],
      ]),
    )
    expect(restarted.state.parentChildren).toEqual(
      new Map([
        ['parent-0', 4],
        ['parent-1', 1],
        ['parent-2', 1],
      ]),
    )
    const resumed = expectAccepted(
      transitionModel(
        restarted.state,
        newAdmission('root-3', 'parent-3', 'req-3'),
      ),
    )
    expect(resumed.permit!.permitId).not.toBe(first.permit!.permitId)
    expect(resumed.permit!.permitId).not.toBe(second.permit!.permitId)
  })

  it('injected ledger failure denies with ADMISSION_STATE_IO and changes nothing', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const denied = expectDenied(
      transitionModel(initial, {
        kind: 'new-admission',
        operation: 'new-one-shot',
        rootId: 'root-1',
        parentId: 'parent-1',
        requestId: 'req-1',
        policyEpoch: 'epoch-1',
        ledgerFailure: true,
      }),
    )
    expect(denied.denial.code).toBe(ADMISSION_ERROR_CODES.ADMISSION_STATE_IO)
    expect(denied.state).toBe(initial)
    expect(initial.globalActive).toBe(0)
    expect(initial.rootActive.size).toBe(0)
    expect(initial.rootAdmittedTotal.size).toBe(0)
    expect(initial.parentChildren.size).toBe(0)
    expect(initial.permits.size).toBe(0)
  })

  it('never mutates caller-owned maps, clones on change, and freezes denial metadata', () => {
    const totals = new Map<string, number>([['root-seeded', 2]])
    const children = new Map<string, number>([['parent-seeded', 1]])
    const initial = createAdmissionState({
      limits: LIMITS,
      rootAdmittedTotal: totals,
      parentChildren: children,
    })
    const accepted = expectAccepted(
      transitionModel(initial, newAdmission('root-1', 'parent-1', 'req-1')),
    )
    expect(totals).toEqual(new Map([['root-seeded', 2]]))
    expect(children).toEqual(new Map([['parent-seeded', 1]]))
    expect(accepted.state.rootAdmittedTotal).not.toBe(totals)
    expect(accepted.state.parentChildren).not.toBe(children)
    expect(accepted.state.rootAdmittedTotal.get('root-seeded')).toBe(2)
    expect(accepted.state.parentChildren.get('parent-seeded')).toBe(1)

    const denied = expectDenied(
      transitionModel(initial, {
        kind: 'new-admission',
        operation: 'new-one-shot',
        rootId: 'root-1',
        parentId: 'parent-1',
        requestId: 'req-denied',
        policyEpoch: 'epoch-1',
        ledgerFailure: true,
      }),
    )
    expect(denied.state).toBe(initial)
    expect(initial.rootAdmittedTotal.get('root-seeded')).toBe(2)
    expect(initial.parentChildren.get('parent-seeded')).toBe(1)
    expect(Object.isFrozen(denied.denial)).toBe(true)
    expect(Object.getPrototypeOf(denied.denial)).toBeNull()
  })

  it('is deterministic: identical inputs produce identical transitions', () => {
    const initial = createAdmissionState({ limits: LIMITS })
    const command = newAdmission('root-1', 'parent-1', 'req-1')
    const first = transitionModel(initial, command)
    const second = transitionModel(initial, command)
    expect(first).toEqual(second)
  })
})
