import * as fc from 'fast-check'
import type { Command } from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { AdmissionLimits } from '../src/types.js'
import { ADMISSION_ERROR_CODES } from '../src/host/errors.js'
import {
  createAdmissionState,
  transitionModel,
  type AdmissionState,
} from '../src/host/state-model.js'

const LIMITS: AdmissionLimits = {
  globalActive: 2,
  perRootActive: 2,
  perRootAdmittedTotal: 3,
  perParentChildren: 3,
}

interface Harness {
  state: AdmissionState
  rootTotals: Map<string, number>
  parentTotals: Map<string, number>
  issuedPermitIds: string[]
}

class NewAdmissionCommand implements Command<Harness, Harness> {
  constructor(
    readonly rootId: string,
    readonly parentId: string,
    readonly operation: 'new-one-shot' | 'new-continuable',
    readonly ledgerFailure: boolean,
  ) {}

  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const prevRootSum = sumValues(prev.rootAdmittedTotal)
    const prevParentSum = sumValues(prev.parentChildren)
    const result = transitionModel(prev, {
      kind: 'new-admission',
      operation: this.operation,
      rootId: this.rootId,
      parentId: this.parentId,
      requestId: `request-${String(m.issuedPermitIds.length)}`,
      policyEpoch: 'property-epoch',
      ...(this.ledgerFailure ? { ledgerFailure: true } : {}),
    })
    m.state = result.state
    assertInvariants(m.state)
    if (result.status === 'denied' || result.status === 'acknowledged') {
      expect(result.state).toBe(prev)
      expect(sumValues(m.state.rootAdmittedTotal)).toBe(prevRootSum)
      expect(sumValues(m.state.parentChildren)).toBe(prevParentSum)
      return
    }
    expect(result.permit).not.toBeNull()
    m.rootTotals.set(this.rootId, (m.rootTotals.get(this.rootId) ?? 0) + 1)
    m.parentTotals.set(
      this.parentId,
      (m.parentTotals.get(this.parentId) ?? 0) + 1,
    )
    m.issuedPermitIds.push(result.permit!.permitId)
    expect(sumValues(m.state.rootAdmittedTotal)).toBe(prevRootSum + 1)
    expect(sumValues(m.state.parentChildren)).toBe(prevParentSum + 1)
    expect(m.state.globalActive).toBe(prev.globalActive + 1)
    expect(m.state.rootActive.get(this.rootId)).toBe(
      (prev.rootActive.get(this.rootId) ?? 0) + 1,
    )
    expect(m.state.rootAdmittedTotal.get(this.rootId)).toBe(
      (prev.rootAdmittedTotal.get(this.rootId) ?? 0) + 1,
    )
    expect(m.state.parentChildren.get(this.parentId)).toBe(
      (prev.parentChildren.get(this.parentId) ?? 0) + 1,
    )
  }

  toString(): string {
    return `new-admission(${this.rootId},${this.parentId},${this.operation},ledger=${String(this.ledgerFailure)})`
  }
}

class ColdResumeCommand implements Command<Harness, Harness> {
  constructor(
    readonly rootId: string,
    readonly parentId: string,
  ) {}

  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const prevRootSum = sumValues(prev.rootAdmittedTotal)
    const prevParentSum = sumValues(prev.parentChildren)
    const result = transitionModel(prev, {
      kind: 'cold-resume',
      rootId: this.rootId,
      parentId: this.parentId,
      requestId: 'cold-request',
      policyEpoch: 'property-epoch',
    })
    m.state = result.state
    assertInvariants(m.state)
    if (result.status === 'denied' || result.status === 'acknowledged') {
      expect(result.state).toBe(prev)
      expect(sumValues(m.state.rootAdmittedTotal)).toBe(prevRootSum)
      expect(sumValues(m.state.parentChildren)).toBe(prevParentSum)
      return
    }
    expect(result.permit).not.toBeNull()
    expect(result.permit!.operation).toBe('cold-resume')
    m.issuedPermitIds.push(result.permit!.permitId)
    expect(sumValues(m.state.rootAdmittedTotal)).toBe(prevRootSum)
    expect(sumValues(m.state.parentChildren)).toBe(prevParentSum)
    expect(m.state.globalActive).toBe(prev.globalActive + 1)
    expect(m.state.rootActive.get(this.rootId)).toBe(
      (prev.rootActive.get(this.rootId) ?? 0) + 1,
    )
  }

  toString(): string {
    return `cold-resume(${this.rootId},${this.parentId})`
  }
}

class ResidentFollowUpCommand implements Command<Harness, Harness> {
  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const result = transitionModel(prev, { kind: 'resident-follow-up' })
    m.state = result.state
    expect(result.status).toBe('acknowledged')
    expect(result.state).toBe(prev)
  }

  toString(): string {
    return 'resident-follow-up'
  }
}

class BindCommand implements Command<Harness, Harness> {
  constructor(
    readonly mode: 'new-child' | 'same-child',
    readonly childId: string,
  ) {}

  check(m: Readonly<Harness>): boolean {
    return m.state.permits.size > 0
  }

  run(m: Harness): void {
    const permitId = [...m.state.permits.keys()][0] ?? null
    if (permitId === null) return
    const permit = m.state.permits.get(permitId)!
    const childId =
      this.mode === 'same-child' && permit.childId !== null
        ? permit.childId
        : this.childId
    const prev = m.state
    const result = transitionModel(prev, {
      kind: 'bind',
      permitId,
      childId,
      requestId: 'bind-request',
      policyEpoch: 'property-epoch',
    })
    m.state = result.state
    assertInvariants(m.state)
    if (result.status === 'denied') {
      expect(result.state).toBe(prev)
      expect(result.denial.code).toBe(
        ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT,
      )
      return
    }
    if (result.status === 'acknowledged') {
      expect(result.state).toBe(prev)
      return
    }
    expect(result.state).not.toBe(prev)
    expect(result.permit?.childId).toBe(childId)
    expect(result.state.globalActive).toBe(prev.globalActive)
  }

  toString(): string {
    return `bind(${this.mode},${this.childId})`
  }
}

class BindMissingCommand implements Command<Harness, Harness> {
  constructor(readonly childId: string) {}

  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const result = transitionModel(prev, {
      kind: 'bind',
      permitId: 'permit-missing',
      childId: this.childId,
      requestId: 'bind-missing',
      policyEpoch: 'property-epoch',
    })
    m.state = result.state
    expect(result.status).toBe('acknowledged')
    expect(result.state).toBe(prev)
  }

  toString(): string {
    return `bind-missing(${this.childId})`
  }
}

class ReleaseExistingCommand implements Command<Harness, Harness> {
  check(m: Readonly<Harness>): boolean {
    return m.state.permits.size > 0
  }

  run(m: Harness): void {
    const permitId = [...m.state.permits.keys()][0] ?? null
    if (permitId === null) return
    const prev = m.state
    const prevRootSum = sumValues(prev.rootAdmittedTotal)
    const prevParentSum = sumValues(prev.parentChildren)
    const result = transitionModel(prev, { kind: 'release', permitId })
    m.state = result.state
    assertInvariants(m.state)
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') {
      throw new Error('expected accepted release')
    }
    expect(result.state.globalActive).toBe(prev.globalActive - 1)
    expect(result.state.permits.size).toBe(prev.permits.size - 1)
    expect(sumValues(m.state.rootAdmittedTotal)).toBe(prevRootSum)
    expect(sumValues(m.state.parentChildren)).toBe(prevParentSum)
  }

  toString(): string {
    return 'release-existing'
  }
}

class ReleaseMissingCommand implements Command<Harness, Harness> {
  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const result = transitionModel(prev, {
      kind: 'release',
      permitId: 'permit-missing',
    })
    m.state = result.state
    expect(result.status).toBe('acknowledged')
    expect(result.state).toBe(prev)
  }

  toString(): string {
    return 'release-missing'
  }
}

class UnloadCommand implements Command<Harness, Harness> {
  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const result = transitionModel(prev, { kind: 'unload' })
    m.state = result.state
    if (prev.lifecycle === 'draining') {
      expect(result.status).toBe('acknowledged')
      expect(result.state).toBe(prev)
      return
    }
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') {
      throw new Error('expected accepted unload')
    }
    expect(result.state.lifecycle).toBe('draining')
    expect(result.state.globalActive).toBe(prev.globalActive)
    expect(result.state.permits.size).toBe(prev.permits.size)
  }

  toString(): string {
    return 'unload'
  }
}

class RestartCommand implements Command<Harness, Harness> {
  check(): boolean {
    return true
  }

  run(m: Harness): void {
    const prev = m.state
    const result = transitionModel(prev, { kind: 'restart' })
    m.state = result.state
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') {
      throw new Error('expected accepted restart')
    }
    expect(m.state.globalActive).toBe(0)
    expect(m.state.rootActive.size).toBe(0)
    expect(m.state.permits.size).toBe(0)
    expect(m.state.lifecycle).toBe('open')
    expect(m.state.rootAdmittedTotal).toEqual(prev.rootAdmittedTotal)
    expect(m.state.parentChildren).toEqual(prev.parentChildren)
    assertInvariants(m.state)
  }

  toString(): string {
    return 'restart'
  }
}

const rootArb = fc.constantFrom('root-a', 'root-b', 'root-c')
const parentArb = fc.constantFrom('parent-a', 'parent-b')
const childArb = fc.constantFrom('child-a', 'child-b', 'child-c')

const commandArbs = [
  fc
    .record({
      rootId: rootArb,
      parentId: parentArb,
      operation: fc.constantFrom<'new-one-shot' | 'new-continuable'>(
        'new-one-shot',
        'new-continuable',
      ),
      ledgerFailure: fc.boolean(),
    })
    .map(
      ({ rootId, parentId, operation, ledgerFailure }) =>
        new NewAdmissionCommand(rootId, parentId, operation, ledgerFailure),
    ),
  fc
    .record({ rootId: rootArb, parentId: parentArb })
    .map(({ rootId, parentId }) => new ColdResumeCommand(rootId, parentId)),
  fc.constant(new ResidentFollowUpCommand()),
  fc
    .record({
      mode: fc.constantFrom<'new-child' | 'same-child'>(
        'new-child',
        'same-child',
      ),
      childId: childArb,
    })
    .map(({ mode, childId }) => new BindCommand(mode, childId)),
  fc.constant(new ReleaseExistingCommand()),
  fc.constant(new ReleaseMissingCommand()),
  fc.record({ childId: childArb }).map(
    ({ childId }) => new BindMissingCommand(childId),
  ),
  fc.constant(new UnloadCommand()),
  fc.constant(new RestartCommand()),
]

describe('admission state model (property)', () => {
  it('preserves bounded-count invariants across bounded command sequences', () => {
    const commandsArb = fc.commands(commandArbs, { maxCommands: 40 })
    const property = fc.property(commandsArb, (cmds) => {
      const harness: Harness = {
        state: createAdmissionState({ limits: LIMITS }),
        rootTotals: new Map(),
        parentTotals: new Map(),
        issuedPermitIds: [],
      }
      fc.modelRun(() => ({ model: harness, real: harness }), cmds)
      assertInvariants(harness.state)
      expect(harness.state.rootAdmittedTotal).toEqual(harness.rootTotals)
      expect(harness.state.parentChildren).toEqual(harness.parentTotals)
      expect(new Set(harness.issuedPermitIds).size).toBe(
        harness.issuedPermitIds.length,
      )
      let state = harness.state
      for (const permitId of state.permits.keys()) {
        const before = state.globalActive
        const released = transitionModel(state, {
          kind: 'release',
          permitId,
        })
        expect(released.status).toBe('accepted')
        if (released.status !== 'accepted') {
          throw new Error('expected accepted release')
        }
        expect(released.state.globalActive).toBe(before - 1)
        const duplicate = transitionModel(released.state, {
          kind: 'release',
          permitId,
        })
        expect(duplicate.status).toBe('acknowledged')
        expect(duplicate.state).toBe(released.state)
        state = released.state
      }
      assertInvariants(state)
    })
    fc.assert(property, {
      numRuns: 100,
      seed: 20260813,
      endOnFailure: true,
    })
  })
})

function assertInvariants(state: AdmissionState): void {
  const { limits } = state
  expect(state.globalActive).toBeGreaterThanOrEqual(0)
  expect(state.globalActive).toBeLessThanOrEqual(limits.globalActive)
  expect(state.permits.size).toBe(state.globalActive)
  const permitsByRoot = new Map<string, number>()
  for (const permit of state.permits.values()) {
    expect(permit.rootId).toBeTruthy()
    expect(permit.parentId).toBeTruthy()
    permitsByRoot.set(permit.rootId, (permitsByRoot.get(permit.rootId) ?? 0) + 1)
  }
  let rootActiveSum = 0
  for (const [rootId, active] of state.rootActive) {
    expect(active).toBeGreaterThanOrEqual(0)
    expect(active).toBeLessThanOrEqual(limits.perRootActive)
    rootActiveSum += active
    expect(permitsByRoot.get(rootId) ?? 0).toBe(active)
  }
  expect(permitsByRoot.size).toBe(state.rootActive.size)
  expect(rootActiveSum).toBe(state.globalActive)
  for (const total of state.rootAdmittedTotal.values()) {
    expect(total).toBeGreaterThanOrEqual(0)
    expect(total).toBeLessThanOrEqual(limits.perRootAdmittedTotal)
  }
  for (const children of state.parentChildren.values()) {
    expect(children).toBeGreaterThanOrEqual(0)
    expect(children).toBeLessThanOrEqual(limits.perParentChildren)
  }
  expect(state.lifecycle === 'open' || state.lifecycle === 'draining').toBe(true)
  expect(Number.isSafeInteger(state.permitCounter)).toBe(true)
}

function sumValues(values: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const value of values.values()) sum += value
  return sum
}
