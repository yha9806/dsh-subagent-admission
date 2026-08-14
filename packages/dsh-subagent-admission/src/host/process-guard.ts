import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export type OwnershipUnavailableReason =
  | 'owner-alive'
  | 'owner-corrupt'
  | 'owner-lost'
  | 'owner-io'

export class OwnershipUnavailable extends Error {
  readonly reason: OwnershipUnavailableReason

  constructor(reason: OwnershipUnavailableReason) {
    super(`Process ownership unavailable: ${reason}`)
    Object.defineProperty(this, 'name', {
      value: 'OwnershipUnavailable',
      enumerable: false,
      writable: true,
      configurable: true,
    })
    this.reason = reason
    Object.freeze(this)
  }
}

export interface OwnerRecord {
  readonly schemaVersion: 1
  readonly pid: number
  readonly nonce: string
  readonly createdAt: number
}

interface FileSystemIdentity {
  readonly dev: number
  readonly ino: number
}

export const OWNER_FILE = 'owner.json'
export const OWNER_SCHEMA_VERSION = 1 as const
export const OWNER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseOwner(text: string): OwnerRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4) return undefined
  if (record.schemaVersion !== OWNER_SCHEMA_VERSION) return undefined
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined
  if (typeof record.nonce !== 'string' || !OWNER_NONCE_PATTERN.test(record.nonce)) return undefined
  if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) return undefined
  return {
    schemaVersion: OWNER_SCHEMA_VERSION,
    pid: record.pid,
    nonce: record.nonce,
    createdAt: record.createdAt,
  }
}

export type OwnerReadResult =
  | { kind: 'ok', record: OwnerRecord }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'io' }

export async function readOwner(lockPath: string): Promise<OwnerReadResult> {
  try {
    const text = await readFile(join(lockPath, OWNER_FILE), 'utf8')
    const record = parseOwner(text)
    return record === undefined ? { kind: 'corrupt' } : { kind: 'ok', record }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'missing' }
    return { kind: 'io' }
  }
}

export async function publishOwner(lockPath: string, record: OwnerRecord): Promise<void> {
  const target = join(lockPath, OWNER_FILE)
  const temp = join(lockPath, `.owner.${record.nonce}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  let closed = false
  try {
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8')
    await handle.sync()
    await handle.close()
    closed = true
    await rename(temp, target)
  } finally {
    if (!closed) await handle.close().catch(() => undefined)
    await rm(temp, { force: true })
  }
}

export function makeOwner(): OwnerRecord {
  return {
    schemaVersion: OWNER_SCHEMA_VERSION,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: Date.now(),
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function probePid(pid: number): 'alive' | 'dead' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return isErrno(error, 'ESRCH') ? 'dead' : 'alive'
  }
}

type OwnerInspection =
  | { kind: 'alive' }
  | { kind: 'corrupt' }
  | { kind: 'io' }
  | { kind: 'missing' }
  | { kind: 'dead', record: OwnerRecord }

type PinnedOwnerReadResult =
  | { kind: 'ok', record: OwnerRecord }
  | { kind: 'lost' }
  | { kind: 'io' }

function matchesIdentity(
  actual: FileSystemIdentity,
  expected: FileSystemIdentity,
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino
}

async function inspectExistingOwner(path: string): Promise<OwnerInspection> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { kind: 'io' }
    }
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'io' }
  }
  const existing = await readOwner(path)
  switch (existing.kind) {
    case 'ok':
      return probePid(existing.record.pid) === 'alive'
        ? { kind: 'alive' }
        : { kind: 'dead', record: existing.record }
    case 'io':
      return { kind: 'io' }
    default:
      return { kind: 'corrupt' }
  }
}

async function quarantineDeadOwner(
  path: string,
  record: OwnerRecord,
): Promise<'retry' | 'quarantined'> {
  const destination = `${path}.quarantine.${record.nonce}`
  let destinationExists = false
  try {
    await lstat(destination)
    destinationExists = true
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new OwnershipUnavailable('owner-io')
    }
  }
  if (destinationExists) {
    throw new OwnershipUnavailable('owner-io')
  }
  try {
    await rename(path, destination)
    return 'quarantined'
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return 'retry'
    }
    try {
      await lstat(path)
    } catch (sourceError) {
      if (isErrno(sourceError, 'ENOENT')) {
        return 'retry'
      }
    }
    throw new OwnershipUnavailable('owner-io')
  }
}

export class ProcessOwnershipGuard {
  private readonly path: string
  private readonly record: OwnerRecord
  private readonly directoryIdentity: FileSystemIdentity
  private readonly ownerIdentity: FileSystemIdentity
  private released = false
  private releasing: Promise<void> | undefined

  private constructor(
    path: string,
    record: OwnerRecord,
    directoryIdentity: FileSystemIdentity,
    ownerIdentity: FileSystemIdentity,
  ) {
    this.path = path
    this.record = record
    this.directoryIdentity = directoryIdentity
    this.ownerIdentity = ownerIdentity
  }

  static async acquire(path: string): Promise<ProcessOwnershipGuard> {
    if (!isAbsolute(path)) {
      throw new OwnershipUnavailable('owner-io')
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mkdir(path, { recursive: false, mode: 0o700 })
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw new OwnershipUnavailable('owner-io')
        }
        const inspection = await inspectExistingOwner(path)
        if (inspection.kind === 'alive') {
          throw new OwnershipUnavailable('owner-alive')
        }
        if (inspection.kind === 'corrupt') {
          throw new OwnershipUnavailable('owner-corrupt')
        }
        if (inspection.kind === 'io') {
          throw new OwnershipUnavailable('owner-io')
        }
        if (inspection.kind === 'missing') {
          continue
        }
        await quarantineDeadOwner(path, inspection.record)
        continue
      }
      const record = makeOwner()
      try {
        await publishOwner(path, record)
      } catch {
        throw new OwnershipUnavailable('owner-io')
      }
      try {
        const directoryStats = await lstat(path)
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
          throw new OwnershipUnavailable('owner-io')
        }
        const ownerStats = await lstat(join(path, OWNER_FILE))
        if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) {
          throw new OwnershipUnavailable('owner-io')
        }
        const guard = new ProcessOwnershipGuard(path, record, {
          dev: directoryStats.dev,
          ino: directoryStats.ino,
        }, {
          dev: ownerStats.dev,
          ino: ownerStats.ino,
        })
        const pinned = await guard.readPinnedOwner(path)
        if (pinned.kind !== 'ok' || pinned.record.nonce !== record.nonce) {
          throw new OwnershipUnavailable('owner-io')
        }
        return guard
      } catch (error) {
        if (error instanceof OwnershipUnavailable) {
          throw error
        }
        throw new OwnershipUnavailable('owner-io')
      }
    }
    throw new OwnershipUnavailable('owner-io')
  }

  async assertHeld(): Promise<void> {
    if (this.released) {
      throw new OwnershipUnavailable('owner-lost')
    }
    const existing = await this.readPinnedOwner(this.path)
    if (existing.kind === 'io') {
      throw new OwnershipUnavailable('owner-io')
    }
    if (existing.kind === 'ok' && existing.record.nonce === this.record.nonce) {
      return
    }
    throw new OwnershipUnavailable('owner-lost')
  }

  async release(): Promise<void> {
    if (this.released) {
      return
    }
    const attempt = this.releasing ?? this.performRelease()
    this.releasing = attempt
    try {
      await attempt
    } catch (error) {
      if (this.releasing === attempt) {
        this.releasing = undefined
      }
      throw error
    }
  }

  private async performRelease(): Promise<void> {
    const existing = await this.readPinnedOwner(this.path)
    if (existing.kind === 'io') {
      throw new OwnershipUnavailable('owner-io')
    }
    if (existing.kind !== 'ok' || existing.record.nonce !== this.record.nonce) {
      this.released = true
      return
    }

    const releasePath = `${this.path}.release.${this.record.nonce}`
    try {
      await lstat(releasePath)
      throw new OwnershipUnavailable('owner-io')
    } catch (error) {
      if (
        error instanceof OwnershipUnavailable ||
        !isErrno(error, 'ENOENT')
      ) {
        throw error instanceof OwnershipUnavailable
          ? error
          : new OwnershipUnavailable('owner-io')
      }
    }

    try {
      await rename(this.path, releasePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.released = true
        return
      }
      throw new OwnershipUnavailable('owner-io')
    }

    if (!(await this.matchesOwnedDirectory(releasePath))) {
      this.released = true
      return
    }

    const movedOwner = await this.readPinnedOwner(releasePath)
    if (movedOwner.kind === 'io') {
      throw new OwnershipUnavailable('owner-io')
    }
    if (
      movedOwner.kind !== 'ok' ||
      movedOwner.record.nonce !== this.record.nonce
    ) {
      this.released = true
      return
    }

    const ownerPath = join(releasePath, OWNER_FILE)
    const tombstonePath = join(
      releasePath,
      `.released.${this.record.nonce}.json`,
    )
    try {
      await lstat(tombstonePath)
      throw new OwnershipUnavailable('owner-io')
    } catch (error) {
      if (
        error instanceof OwnershipUnavailable ||
        !isErrno(error, 'ENOENT')
      ) {
        throw error instanceof OwnershipUnavailable
          ? error
          : new OwnershipUnavailable('owner-io')
      }
    }

    try {
      await rename(ownerPath, tombstonePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.released = true
        return
      }
      throw new OwnershipUnavailable('owner-io')
    }

    if (!(await this.matchesOwnedFile(tombstonePath))) {
      this.released = true
      return
    }

    try {
      await unlink(tombstonePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.released = true
        return
      }
      throw new OwnershipUnavailable('owner-io')
    }

    try {
      await rmdir(releasePath)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw new OwnershipUnavailable('owner-io')
      }
    }
    this.released = true
  }

  private async readPinnedOwner(
    basePath: string,
  ): Promise<PinnedOwnerReadResult> {
    const ownerPath = join(basePath, OWNER_FILE)
    try {
      const directoryBefore = await lstat(basePath)
      if (
        !directoryBefore.isDirectory() ||
        directoryBefore.isSymbolicLink() ||
        !matchesIdentity(directoryBefore, this.directoryIdentity)
      ) {
        return { kind: 'lost' }
      }

      const ownerBefore = await lstat(ownerPath)
      if (
        !ownerBefore.isFile() ||
        ownerBefore.isSymbolicLink() ||
        !matchesIdentity(ownerBefore, this.ownerIdentity)
      ) {
        return { kind: 'lost' }
      }

      const handle = await open(ownerPath, 'r')
      let text: string
      try {
        const openedOwner = await handle.stat()
        if (
          !openedOwner.isFile() ||
          !matchesIdentity(openedOwner, this.ownerIdentity)
        ) {
          return { kind: 'lost' }
        }
        text = await handle.readFile({ encoding: 'utf8' })
      } finally {
        await handle.close().catch(() => undefined)
      }

      const ownerAfter = await lstat(ownerPath)
      if (
        !ownerAfter.isFile() ||
        ownerAfter.isSymbolicLink() ||
        !matchesIdentity(ownerAfter, this.ownerIdentity)
      ) {
        return { kind: 'lost' }
      }

      const directoryAfter = await lstat(basePath)
      if (
        !directoryAfter.isDirectory() ||
        directoryAfter.isSymbolicLink() ||
        !matchesIdentity(directoryAfter, this.directoryIdentity)
      ) {
        return { kind: 'lost' }
      }

      const record = parseOwner(text)
      return record === undefined
        ? { kind: 'lost' }
        : { kind: 'ok', record }
    } catch (error) {
      if (
        isErrno(error, 'ENOENT') ||
        isErrno(error, 'ENOTDIR') ||
        isErrno(error, 'ELOOP')
      ) {
        return { kind: 'lost' }
      }
      return { kind: 'io' }
    }
  }

  private async matchesOwnedDirectory(path: string): Promise<boolean> {
    try {
      const stats = await lstat(path)
      return (
        stats.isDirectory() &&
        !stats.isSymbolicLink() &&
        matchesIdentity(stats, this.directoryIdentity)
      )
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
        return false
      }
      throw new OwnershipUnavailable('owner-io')
    }
  }

  private async matchesOwnedFile(path: string): Promise<boolean> {
    try {
      const before = await lstat(path)
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        !matchesIdentity(before, this.ownerIdentity)
      ) {
        return false
      }

      const handle = await open(path, 'r')
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          !matchesIdentity(opened, this.ownerIdentity)
        ) {
          return false
        }
      } finally {
        await handle.close().catch(() => undefined)
      }

      const after = await lstat(path)
      return (
        after.isFile() &&
        !after.isSymbolicLink() &&
        matchesIdentity(after, this.ownerIdentity)
      )
    } catch (error) {
      if (
        isErrno(error, 'ENOENT') ||
        isErrno(error, 'ENOTDIR') ||
        isErrno(error, 'ELOOP')
      ) {
        return false
      }
      throw new OwnershipUnavailable('owner-io')
    }
  }
}
