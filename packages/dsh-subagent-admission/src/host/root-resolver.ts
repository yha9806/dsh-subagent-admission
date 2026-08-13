import { ADMISSION_ERROR_CODES } from './errors.js'

/**
 * Task 3: durable all-parent root resolution and immutable child bindings.
 *
 * `DurableRootResolver` walks every durable parent header, including ordinary
 * forks and subagents, until it reaches a header without `parentSession`.
 * Nothing is cached until the whole chain has succeeded, so a failed or
 * partial traversal can never poison a later resolution. `bindChild` is a
 * process-local, telemetry-only association: it never calls `inspect` and
 * never fabricates a durable header.
 */

/**
 * The narrow persistence surface consumed by the resolver. The returned
 * header must echo the requested id; any richer fields (origin, counters,
 * etc.) are ignored and must never leak into operational errors.
 */
export interface SessionHeaderReader {
  inspect(
    sessionId: string,
  ): Promise<
    { readonly id: string; readonly parentSession?: string } | undefined
  >
}

/** Leaf-to-root durable lineage of one admitted session. */
export interface ResolvedLineage {
  readonly rootSessionId: string
  readonly lineage: readonly string[]
}

/** Caller-provided child binding claim, consumed read-only. */
export interface ChildBindingInput {
  readonly childSessionId: string
  readonly expectedParentSessionId: string
  readonly expectedRootSessionId: string
  readonly localParentSessionId?: string
}

export interface RootResolution {
  resolve(parentSessionId: string): Promise<ResolvedLineage>
  bindChild(input: ChildBindingInput): void
}

/**
 * Maximum durable headers one successful traversal may visit. Exactly 1,024
 * headers resolve; the 1,025th header fails closed.
 */
const MAX_TRAVERSAL_HEADERS = 1024

type ResolverErrorCode =
  | typeof ADMISSION_ERROR_CODES.ADMISSION_UNAVAILABLE
  | typeof ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT

interface ResolverErrorIds {
  readonly sessionId?: string
  readonly childSessionId?: string
}

/**
 * Operational failure carrying only a stable code and the ids involved in the
 * operation. Header bodies, arbitrary metadata, prompts, messages, and stacks
 * are never attached.
 */
class ResolverOperationalError extends Error {
  declare readonly code: ResolverErrorCode
  declare readonly sessionId?: string
  declare readonly childSessionId?: string

  constructor(code: ResolverErrorCode, ids: ResolverErrorIds) {
    super(code)
    this.code = code
    if (ids.sessionId !== undefined) {
      this.sessionId = ids.sessionId
    }
    if (ids.childSessionId !== undefined) {
      this.childSessionId = ids.childSessionId
    }
  }
}

export class DurableRootResolver implements RootResolution {
  private readonly headers: SessionHeaderReader
  /** Durable lineages, populated only after a whole chain succeeds. */
  private readonly resolved = new Map<string, ResolvedLineage>()
  /** Telemetry-only child-to-root claims recorded by `bindChild`. */
  private readonly boundRoots = new Map<string, string>()

  constructor(headers: SessionHeaderReader) {
    this.headers = headers
  }

  async resolve(parentSessionId: string): Promise<ResolvedLineage> {
    const memoized = this.resolved.get(parentSessionId)
    if (memoized !== undefined) {
      return memoized
    }

    const path: string[] = []
    const visited = new Set<string>()
    let currentId = parentSessionId
    let reachedRoot = false

    while (!reachedRoot) {
      const header = await this.headers.inspect(currentId)
      if (header === undefined) {
        failUnavailable(currentId)
      }
      if (header.id !== currentId) {
        failUnavailable(currentId)
      }
      if (visited.has(currentId)) {
        failUnavailable(currentId)
      }
      visited.add(currentId)
      path.push(currentId)
      if (visited.size > MAX_TRAVERSAL_HEADERS) {
        failUnavailable(currentId)
      }
      if (header.parentSession === undefined) {
        reachedRoot = true
      } else {
        currentId = header.parentSession
      }
    }

    const rootSessionId = path[path.length - 1]
    if (rootSessionId === undefined) {
      // Unreachable: the starting id is always visited.
      failUnavailable(parentSessionId)
    }

    // The whole chain succeeded, so every visited id is now verified. Freeze
    // both the lineage arrays and the snapshot so caller mutation can never
    // corrupt process-local memoization.
    const leafLineage = this.memoize(rootSessionId, path, 0)
    for (let index = 1; index < path.length; index += 1) {
      this.memoize(rootSessionId, path, index)
    }
    return leafLineage
  }

  bindChild(input: ChildBindingInput): void {
    const {
      childSessionId,
      expectedParentSessionId,
      expectedRootSessionId,
      localParentSessionId,
    } = input

    const boundRoot = this.boundRoots.get(childSessionId)
    if (boundRoot !== undefined) {
      if (boundRoot !== expectedRootSessionId) {
        failConflict(childSessionId)
      }
      // Same-root repeat: idempotent.
      return
    }

    const resolvedChild = this.resolved.get(childSessionId)
    if (
      resolvedChild !== undefined &&
      resolvedChild.rootSessionId !== expectedRootSessionId
    ) {
      failConflict(childSessionId)
    }

    if (
      localParentSessionId !== undefined &&
      localParentSessionId !== expectedParentSessionId
    ) {
      failConflict(childSessionId)
    }

    const resolvedParent = this.resolved.get(expectedParentSessionId)
    if (
      resolvedParent !== undefined &&
      resolvedParent.rootSessionId !== expectedRootSessionId
    ) {
      failConflict(childSessionId)
    }

    this.boundRoots.set(childSessionId, expectedRootSessionId)
  }

  /**
   * Freezes and stores the suffix lineage starting at `path[index]`. The
   * snapshot is defensive: neither the outer record nor the lineage array can
   * be mutated by a caller holding the returned reference.
   */
  private memoize(
    rootSessionId: string,
    path: readonly string[],
    index: number,
  ): ResolvedLineage {
    const lineage: ResolvedLineage = Object.freeze({
      rootSessionId,
      lineage: Object.freeze(path.slice(index)),
    })
    const sessionId = path[index]
    if (sessionId !== undefined) {
      this.resolved.set(sessionId, lineage)
    }
    return lineage
  }
}

function failUnavailable(sessionId: string): never {
  throw new ResolverOperationalError(
    ADMISSION_ERROR_CODES.ADMISSION_UNAVAILABLE,
    { sessionId },
  )
}

function failConflict(childSessionId: string): never {
  throw new ResolverOperationalError(
    ADMISSION_ERROR_CODES.ADMISSION_BINDING_CONFLICT,
    { childSessionId },
  )
}
