import s from '@deepseek-ai/schemastery'

import type { ConfiguredAdmissionMode } from './compatibility.js'

/** Flat startup configuration for the admission policy. */
export interface Config {
  readonly mode: ConfiguredAdmissionMode
  readonly globalActive: number
  readonly perRootActive: number
  readonly perRootAdmittedTotal: number
  readonly perParentChildren: number
  readonly ownershipPath: string
}

/** Partial user-supplied configuration; missing fields inherit the defaults. */
export interface ConfigInput {
  mode?: ConfiguredAdmissionMode
  globalActive?: number
  perRootActive?: number
  perRootAdmittedTotal?: number
  perParentChildren?: number
  ownershipPath?: string
}

/**
 * v0.1 defaults, matching the installed bundle patch row: audit mode, six
 * global active activations, four per root, 24 post-coverage admissions per
 * root, and eight direct children per parent. The ownership path mirrors the
 * patch's `dshHomePath('sessions/.dsh-subagent-admission-owner')` target.
 */
export const DEFAULT_CONFIG: Config = {
  mode: 'audit',
  globalActive: 6,
  perRootActive: 4,
  perRootAdmittedTotal: 24,
  perParentChildren: 8,
  ownershipPath: 'sessions/.dsh-subagent-admission-owner',
}

/** Cordis loader schema. Cross-field constraints remain in resolveConfig. */
export const Config = s.object({
  mode: s.union([s.const('strict'), s.const('audit')]).default('audit'),
  globalActive: s.number().step(1).min(1).default(6),
  perRootActive: s.number().step(1).min(1).default(4),
  perRootAdmittedTotal: s.number().step(1).min(1).default(24),
  perParentChildren: s.number().step(1).min(1).default(8),
  ownershipPath: s.string().default(
    'sessions/.dsh-subagent-admission-owner',
  ),
}) as s<ConfigInput, Config>

/**
 * Resolves configuration against the defaults and rejects incoherent limits.
 *
 * The four limits must be positive safe integers, and:
 * - perRootActive <= globalActive
 * - perRootActive <= perRootAdmittedTotal
 * - perParentChildren <= perRootAdmittedTotal
 */
export function resolveConfig(input: ConfigInput = {}): Config {
  const config: Config = {
    mode: input.mode ?? DEFAULT_CONFIG.mode,
    globalActive: input.globalActive ?? DEFAULT_CONFIG.globalActive,
    perRootActive: input.perRootActive ?? DEFAULT_CONFIG.perRootActive,
    perRootAdmittedTotal:
      input.perRootAdmittedTotal ?? DEFAULT_CONFIG.perRootAdmittedTotal,
    perParentChildren:
      input.perParentChildren ?? DEFAULT_CONFIG.perParentChildren,
    ownershipPath: input.ownershipPath ?? DEFAULT_CONFIG.ownershipPath,
  }
  if (config.mode !== 'strict' && config.mode !== 'audit') {
    throw new Error('mode must be strict or audit')
  }
  assertPositiveSafeInteger(config.globalActive, 'globalActive')
  assertPositiveSafeInteger(config.perRootActive, 'perRootActive')
  assertPositiveSafeInteger(config.perRootAdmittedTotal, 'perRootAdmittedTotal')
  assertPositiveSafeInteger(config.perParentChildren, 'perParentChildren')
  if (config.perRootActive > config.globalActive) {
    throw new Error('perRootActive must not exceed globalActive')
  }
  if (config.perRootActive > config.perRootAdmittedTotal) {
    throw new Error('perRootActive must not exceed perRootAdmittedTotal')
  }
  if (config.perParentChildren > config.perRootAdmittedTotal) {
    throw new Error('perParentChildren must not exceed perRootAdmittedTotal')
  }
  if (config.ownershipPath.length === 0) {
    throw new Error('ownershipPath must not be empty')
  }
  return Object.freeze(config)
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
