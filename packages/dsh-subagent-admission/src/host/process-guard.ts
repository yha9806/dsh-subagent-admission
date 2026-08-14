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
  readonly schemaVersion: number
  readonly pid: number
  readonly nonce: string
  readonly createdAt: number
}

interface DirectoryIdentity {
  readonly dev: number
  readonly ino: number
}

export const OWNER_FILE = 'owner.json'
export const OWNER_SCHEMA_VERSION = 1
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
    schemaVersion: record.schemaVersion,
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

async function cleanOwnedPath(path: string, record: OwnerRecord): Promise<void> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return
    }
  } catch {
    return
  }
  const existing = await readOwner(path)
  if (existing.kind === 'ok' && existing.record.nonce === record.nonce) {
    await unlink(join(path, OWNER_FILE)).catch(() => undefined)
  }
  await rmdir(path).catch(() => undefined)
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
  private readonly identity: DirectoryIdentity
  private released = false
  private releasing: Promise<void> | undefined

  private constructor(path: string, record: OwnerRecord, identity: DirectoryIdentity) {
    this.path = path
    this.record = record
    this.identity = identity
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
        await unlink(join(path, OWNER_FILE)).catch(() => undefined)
        await rmdir(path).catch(() => undefined)
        throw new OwnershipUnavailable('owner-io')
      }
      try {
        const stats = await lstat(path)
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new OwnershipUnavailable('owner-io')
        }
        return new ProcessOwnershipGuard(path, record, {
          dev: stats.dev,
          ino: stats.ino,
        })
      } catch (error) {
        if (error instanceof OwnershipUnavailable) {
          throw error
        }
        await cleanOwnedPath(path, record)
        throw new OwnershipUnavailable('owner-io')
      }
    }
    throw new OwnershipUnavailable('owner-io')
  }

  async assertHeld(): Promise<void> {
    if (this.released) {
      throw new OwnershipUnavailable('owner-lost')
    }
    if (!(await this.matchesOwnedDirectory())) {
      throw new OwnershipUnavailable('owner-lost')
    }
    const existing = await readOwner(this.path)
    if (existing.kind === 'io') {
      throw new OwnershipUnavailable('owner-io')
    }
    if (existing.kind === 'ok' && existing.record.nonce === this.record.nonce) {
      if (await this.matchesOwnedDirectory()) {
        return
      }
    }
    throw new OwnershipUnavailable('owner-lost')
  }

  async release(): Promise<void> {
    if (this.released) {
      return
    }
    this.releasing ??= this.performRelease()
    await this.releasing
  }

  private async performRelease(): Promise<void> {
    if (!(await this.matchesOwnedDirectory())) {
      this.released = true
      return
    }
    const existing = await readOwner(this.path)
    if (existing.kind === 'io') {
      throw new OwnershipUnavailable('owner-io')
    }
    if (existing.kind !== 'ok' || existing.record.nonce !== this.record.nonce) {
      this.released = true
      return
    }
    if (!(await this.matchesOwnedDirectory())) {
      this.released = true
      return
    }
    try {
      await unlink(join(this.path, OWNER_FILE))
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw new OwnershipUnavailable('owner-io')
      }
    }
    try {
      await rmdir(this.path)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw new OwnershipUnavailable('owner-io')
      }
    }
    this.released = true
  }

  private async matchesOwnedDirectory(): Promise<boolean> {
    try {
      const stats = await lstat(this.path)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return false
      }
      return stats.dev === this.identity.dev && stats.ino === this.identity.ino
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return false
      }
      throw new OwnershipUnavailable('owner-io')
    }
  }
}
