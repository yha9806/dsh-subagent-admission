/**
 * Host entry for the dsh-subagent-admission dual-face plugin.
 *
 * Task 1 ships the packaging skeleton only: this apply is a deliberate no-op.
 * The admission authority, Audit observer, and Typert Remote surface arrive in
 * later tasks.
 */

/** Stable plugin identity used by the Cordis loader and bundle patch rows. */
export const name = 'dsh-subagent-admission'

/** Deliberate no-op until the admission service lands in a later task. */
export function apply(): void {}
