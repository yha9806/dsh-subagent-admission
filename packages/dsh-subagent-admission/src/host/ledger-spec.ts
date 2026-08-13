import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z, type ZodType } from 'zod'

export interface RootLedgerRow {
  readonly schemaVersion: 1
  readonly rootSessionId: string
  readonly coverageStartedAt: number
  readonly admittedTotal: number
  readonly admittedChildrenByParent: Readonly<Record<string, number>>
  readonly revision: number
}

const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe()

function toParentEntries(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return Object.entries(value)
}

function buildChildrenMap(
  entries: [string, number][],
): Readonly<Record<string, number>> {
  const map = Object.create(null) as Record<string, number>
  for (const [parentId, count] of entries) {
    Object.defineProperty(map, parentId, {
      value: count,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(map)
}

/**
 * Parent IDs are arbitrary nonempty strings and may be '__proto__',
 * 'constructor', or 'prototype'. JSON.parse preserves those keys as own data
 * properties, but zod's record parser rebuilds its output with plain property
 * assignment and silently drops '__proto__'. Validate persisted maps as
 * [parentId, count] entries and rebuild a null-prototype map so every key
 * stays an own data key. The cast only fixes the compile-time input type;
 * runtime input is the raw persisted map.
 */
const admittedChildrenByParentSchema = (
  z
    .preprocess(
      toParentEntries,
      z.array(z.tuple([z.string().min(1), nonnegativeSafeIntegerSchema])),
    )
    .transform(buildChildrenMap)
) as unknown as ZodType<Readonly<Record<string, number>>>

const rootLedgerRowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rootSessionId: z.string().min(1),
  coverageStartedAt: nonnegativeSafeIntegerSchema,
  admittedTotal: nonnegativeSafeIntegerSchema,
  admittedChildrenByParent: admittedChildrenByParentSchema,
  revision: nonnegativeSafeIntegerSchema,
})

export const ROOT_LEDGER_DOMAIN_NAME = 'subagent_admission'
export const ROOT_LEDGER_DOMAIN_VERSION = 1

export const rootLedgerDomainSpec = defineDomain({
  name: ROOT_LEDGER_DOMAIN_NAME,
  version: ROOT_LEDGER_DOMAIN_VERSION,
  tables: {
    roots: domainTable<string, RootLedgerRow>(rootLedgerRowSchema),
  },
})

/**
 * Defensive deep copy: a fresh null-prototype map with own data keys only,
 * both the map and the row frozen. Returns no alias to the stored record.
 */
export function cloneFrozenRootLedgerRow(
  row: RootLedgerRow,
): Readonly<RootLedgerRow> {
  const admittedChildrenByParent = Object.create(null) as Record<string, number>
  for (const [parentId, count] of Object.entries(row.admittedChildrenByParent)) {
    Object.defineProperty(admittedChildrenByParent, parentId, {
      value: count,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  Object.freeze(admittedChildrenByParent)

  const cloned: RootLedgerRow = {
    schemaVersion: 1,
    rootSessionId: row.rootSessionId,
    coverageStartedAt: row.coverageStartedAt,
    admittedTotal: row.admittedTotal,
    admittedChildrenByParent,
    revision: row.revision,
  }
  return Object.freeze(cloned)
}
