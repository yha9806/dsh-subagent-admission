import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  OWNER_FILE,
  OwnershipUnavailable,
  ProcessOwnershipGuard,
} from '../src/host/process-guard.js'

type Guard = Awaited<ReturnType<typeof ProcessOwnershipGuard.acquire>>
type OwnershipUnavailableReason =
  | 'owner-alive'
  | 'owner-corrupt'
  | 'owner-lost'
  | 'owner-io'

async function makeLockRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-process-guard-'))
}

async function expectOwnershipUnavailable(
  attempt: Promise<unknown>,
  reason: OwnershipUnavailableReason,
): Promise<void> {
  const error: unknown = await attempt.then(
    () => {
      throw new Error(
        `expected the guarded operation to reject with ${reason}, but it resolved`,
      )
    },
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(OwnershipUnavailable)
  expect(error).toHaveProperty('reason', reason)
  expect(error).toHaveProperty(
    'message',
    `Process ownership unavailable: ${reason}`,
  )
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

async function writeOwner(lockPath: string, pid: number): Promise<string> {
  await mkdir(lockPath)
  const owner = {
    schemaVersion: 1,
    pid,
    nonce: randomUUID(),
    createdAt: 1,
  }
  const raw = `${JSON.stringify(owner)}\n`
  await writeFile(join(lockPath, OWNER_FILE), raw, 'utf8')
  return raw
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid
  if (pid === undefined) {
    throw new Error('failed to start dead owner child process')
  }
  await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('dead owner child did not exit within 3s')),
        3_000,
      )
    }),
  ])
  return pid
}

async function liveChild(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, [
    '-e',
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
  ])
  if (child.pid === undefined || child.stdout === null) {
    child.kill('SIGKILL')
    throw new Error('failed to start live owner child process')
  }
  await Promise.race([
    once(child.stdout, 'data'),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('live owner child did not become ready within 3s')),
        3_000,
      )
    }),
  ])
  return child
}

async function waitForChildReady(
  child: ReturnType<typeof spawn>,
  childStderr: () => string,
): Promise<void> {
  const stdout = child.stdout
  if (stdout === null) {
    throw new Error('cross-process owner child has no stdout stream')
  }
  let output = ''
  await new Promise<void>((resolveReady, rejectReady) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectReady(
        new Error(
          `cross-process owner child did not print ready within 3s; child stderr:\n${childStderr()}`,
        ),
      )
    }, 3_000)
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      if (output.includes('ready\n')) {
        cleanup()
        resolveReady()
      }
    }
    const onExit = (): void => {
      cleanup()
      rejectReady(
        new Error(
          `cross-process owner child exited before printing ready; child stderr:\n${childStderr()}`,
        ),
      )
    }
    stdout.setEncoding('utf8')
    stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

describe('ProcessOwnershipGuard', () => {
  it('allows one live owner, rejects a second acquire as owner-alive, and reacquires after release', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    let first: Guard | undefined
    let second: Guard | undefined
    try {
      first = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(first.assertHeld()).resolves.toBeUndefined()
      await expectOwnershipUnavailable(
        ProcessOwnershipGuard.acquire(lockPath),
        'owner-alive',
      )
      await first.release()
      second = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(second.assertHeld()).resolves.toBeUndefined()
    } finally {
      await first?.release()
      await second?.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases idempotently under concurrent repeated release and allows reacquire afterwards', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    let guard: Guard | undefined
    let reacquired: Guard | undefined
    try {
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(guard.assertHeld()).resolves.toBeUndefined()
      await Promise.all([guard.release(), guard.release(), guard.release()])
      await expect(guard.release()).resolves.toBeUndefined()
      reacquired = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(reacquired.assertHeld()).resolves.toBeUndefined()
    } finally {
      await guard?.release()
      await reacquired?.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a relative ownership path as owner-io and writes nothing relative to cwd', async () => {
    const root = await makeLockRoot()
    const relativeBase = `.dsh-process-guard-relative-${randomUUID()}`
    const relativeLockPath = join(relativeBase, 'ownership')
    try {
      await expectOwnershipUnavailable(
        ProcessOwnershipGuard.acquire(relativeLockPath),
        'owner-io',
      )
      await expect(stat(relativeLockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      // The relative-path acquire must reject before ownership is taken, so
      // there is no guard to release; only the cleanup paths are removed.
      await rm(relativeBase, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects acquire as owner-alive with an exact sanitized error when a live child owns the record, leaving the raw owner unchanged', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    const live = await liveChild()
    const pid = live.pid
    if (pid === undefined) {
      throw new Error('live owner child has no pid')
    }
    try {
      const raw = await writeOwner(lockPath, pid)
      const error: unknown = await ProcessOwnershipGuard.acquire(lockPath).then(
        () => {
          throw new Error(
            'expected acquire to reject with owner-alive, but it resolved',
          )
        },
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(OwnershipUnavailable)
      expect(error).toHaveProperty('reason', 'owner-alive')
      expect(error).toHaveProperty(
        'message',
        'Process ownership unavailable: owner-alive',
      )
      expect((error as OwnershipUnavailable).message).not.toContain(String(pid))
      expect(await readFile(join(lockPath, OWNER_FILE), 'utf8')).toBe(raw)
    } finally {
      if (live.exitCode === null && live.signalCode === null) {
        const exited = once(live, 'exit')
        live.kill('SIGKILL')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quarantines a dead owner record and acquires successfully', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    let guard: Guard | undefined
    try {
      const raw = await writeOwner(lockPath, await deadPid())
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(guard.assertHeld()).resolves.toBeUndefined()
      const entries = await readdir(root)
      expect(entries.filter((entry) => entry === 'ownership')).toHaveLength(1)
      const quarantined = entries.filter((entry) =>
        entry.startsWith('ownership.quarantine.'),
      )
      expect(quarantined).toHaveLength(1)
      const quarantinedDir = quarantined[0]
      if (quarantinedDir === undefined) {
        throw new Error('quarantine directory missing from root')
      }
      expect(
        await readFile(join(root, quarantinedDir, OWNER_FILE), 'utf8'),
      ).toBe(raw)
      await guard.release()
    } finally {
      await guard?.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects every corrupt owner shape as owner-corrupt without touching the raw owner file or lock dir', async () => {
    const valid = {
      schemaVersion: 1,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: 1,
    }
    const cases: ReadonlyArray<{ name: string; raw?: string }> = [
      { name: 'missing owner.json' },
      { name: 'malformed json', raw: '{' },
      {
        name: 'foreign schemaVersion',
        raw: `${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`,
      },
      { name: 'pid 0', raw: `${JSON.stringify({ ...valid, pid: 0 })}\n` },
      {
        name: "nonce 'unsafe'",
        raw: `${JSON.stringify({ ...valid, nonce: 'unsafe' })}\n`,
      },
      {
        name: 'createdAt -1',
        raw: `${JSON.stringify({ ...valid, createdAt: -1 })}\n`,
      },
      {
        name: 'extra key',
        raw: `${JSON.stringify({ ...valid, extra: true })}\n`,
      },
    ]
    for (const { raw } of cases) {
      const root = await makeLockRoot()
      const lockPath = join(root, 'ownership')
      const ownerPath = join(lockPath, OWNER_FILE)
      try {
        await mkdir(lockPath)
        if (raw !== undefined) {
          await writeFile(ownerPath, raw, 'utf8')
        }
        await expectOwnershipUnavailable(
          ProcessOwnershipGuard.acquire(lockPath),
          'owner-corrupt',
        )
        expect((await stat(lockPath)).isDirectory()).toBe(true)
        if (raw !== undefined) {
          expect(await readFile(ownerPath, 'utf8')).toBe(raw)
        } else {
          await expect(stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('loses ownership when the owner nonce is replaced and leaves the replacement record intact on release', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    const ownerPath = join(lockPath, OWNER_FILE)
    let guard: Guard | undefined
    try {
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      const original = JSON.parse(
        await readFile(ownerPath, 'utf8'),
      ) as Record<string, unknown>
      const replacement = {
        ...original,
        nonce: randomUUID(),
      }
      const replacementRaw = `${JSON.stringify(replacement)}\n`
      await writeFile(ownerPath, replacementRaw, 'utf8')
      await expectOwnershipUnavailable(guard.assertHeld(), 'owner-lost')
      await expect(guard.release()).resolves.toBeUndefined()
      expect(await readFile(ownerPath, 'utf8')).toBe(replacementRaw)
      expect((await stat(lockPath)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loses ownership when the owner file and lock dir are removed externally, then release resolves', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    const ownerPath = join(lockPath, OWNER_FILE)
    let guard: Guard | undefined
    try {
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      await unlink(ownerPath)
      await rmdir(lockPath)
      await expectOwnershipUnavailable(guard.assertHeld(), 'owner-lost')
      await expect(guard.release()).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects file and symlink collisions as owner-io without touching the colliding paths', async () => {
    const fileRoot = await makeLockRoot()
    const filePath = join(fileRoot, 'ownership')
    const fileContent = `collision-${randomUUID()}`
    try {
      await writeFile(filePath, fileContent, 'utf8')
      await expectOwnershipUnavailable(
        ProcessOwnershipGuard.acquire(filePath),
        'owner-io',
      )
      expect(await readFile(filePath, 'utf8')).toBe(fileContent)
    } finally {
      await rm(fileRoot, { recursive: true, force: true })
    }

    const linkRoot = await makeLockRoot()
    const linkPath = join(linkRoot, 'ownership')
    const targetPath = join(linkRoot, 'target')
    const targetFile = join(targetPath, 'marker.txt')
    const targetContent = `target-${randomUUID()}`
    try {
      await mkdir(targetPath)
      await writeFile(targetFile, targetContent, 'utf8')
      try {
        await symlink(targetPath, linkPath)
      } catch (error) {
        if (isPermissionError(error)) {
          return
        }
        throw error
      }
      await expectOwnershipUnavailable(
        ProcessOwnershipGuard.acquire(linkPath),
        'owner-io',
      )
      expect(await readFile(targetFile, 'utf8')).toBe(targetContent)
    } finally {
      await rm(linkRoot, { recursive: true, force: true })
    }
  })

  it('rejects a cross-process acquire while a child process owns the lock, then quarantines and reacquires after the child is killed', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    const guardModuleUrl = pathToFileURL(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/host/process-guard.ts'),
    ).href
    const script = [
      `import { ProcessOwnershipGuard } from ${JSON.stringify(guardModuleUrl)}`,
      `const guard = await ProcessOwnershipGuard.acquire(${JSON.stringify(lockPath)})`,
      `process.stdout.write('ready\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    let child: ReturnType<typeof spawn> | undefined
    let guard: Guard | undefined
    const stderrChunks: string[] = []
    const childStderr = (): string => stderrChunks.join('')
    try {
      child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrChunks.push(chunk)
      })
      await waitForChildReady(child, childStderr)
      await expectOwnershipUnavailable(
        ProcessOwnershipGuard.acquire(lockPath),
        'owner-alive',
      )
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  'cross-process owner child did not exit within 3s after SIGKILL',
                ),
              ),
            3_000,
          )
        }),
      ])
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      await expect(guard.assertHeld()).resolves.toBeUndefined()
      const entries = await readdir(root)
      expect(entries.filter((entry) => entry === 'ownership')).toHaveLength(1)
      expect(
        entries.filter((entry) => entry.startsWith('ownership.quarantine.')),
      ).toHaveLength(1)
      await guard.release()
    } finally {
      if (
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await guard?.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loses ownership when the lock dir is replaced by a symlinked lookalike, and release leaves the real paths intact', async () => {
    const root = await makeLockRoot()
    const lockPath = join(root, 'ownership')
    const heldSibling = join(root, 'held-ownership')
    const targetPath = join(root, 'target')
    const markerPath = join(targetPath, 'marker.txt')
    const targetOwnerPath = join(targetPath, OWNER_FILE)
    const marker = `marker-${randomUUID()}`
    let guard: Guard | undefined
    try {
      guard = await ProcessOwnershipGuard.acquire(lockPath)
      const raw = await readFile(join(lockPath, OWNER_FILE), 'utf8')
      await rename(lockPath, heldSibling)
      await mkdir(targetPath)
      await writeFile(markerPath, marker, 'utf8')
      await writeFile(targetOwnerPath, raw, 'utf8')
      try {
        await symlink(targetPath, lockPath)
      } catch (error) {
        if (isPermissionError(error)) {
          return
        }
        throw error
      }
      const assertion: unknown = await guard.assertHeld().then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(assertion).toBeInstanceOf(OwnershipUnavailable)
      expect(assertion).toHaveProperty('reason', 'owner-lost')
      expect(assertion).toHaveProperty(
        'message',
        'Process ownership unavailable: owner-lost',
      )
      const released: unknown = await guard.release().then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(released).toBeUndefined()
      expect(await readFile(targetOwnerPath, 'utf8')).toBe(raw)
      expect(await readFile(markerPath, 'utf8')).toBe(marker)
      expect((await lstat(lockPath)).isSymbolicLink()).toBe(true)
      expect(await readFile(join(heldSibling, OWNER_FILE), 'utf8')).toBe(raw)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
