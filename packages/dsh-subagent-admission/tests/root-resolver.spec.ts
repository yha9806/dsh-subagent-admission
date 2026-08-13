import { describe, expect, it, vi } from 'vitest'
import { DurableRootResolver, type SessionHeaderReader } from '../src/host/root-resolver.js'

interface FakeHeader {
  readonly id: string
  readonly parentSession?: string
  readonly origin?: string
}

function makeReader(headers: Record<string, FakeHeader>) {
  return {
    inspect: vi.fn(
      async (sessionId: string): Promise<FakeHeader | undefined> => {
        const header = headers[sessionId]
        return header ? { ...header } : undefined
      },
    ),
  } satisfies SessionHeaderReader
}

function resolverFor(headers: Record<string, FakeHeader>) {
  const reader = makeReader(headers)
  return { resolver: new DurableRootResolver(reader), reader }
}

function expectBindingConflict(action: () => void) {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ code: 'ADMISSION_BINDING_CONFLICT' })
  return caught
}

describe('DurableRootResolver.resolve', () => {
  it('walks ordinary forks and subagents to one stable root', async () => {
    const { resolver } = resolverFor({
      root: { id: 'root' },
      fork: { id: 'fork', parentSession: 'root' },
      child: { id: 'child', parentSession: 'fork', origin: 'subagent' },
    })
    await expect(resolver.resolve('child')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['child', 'fork', 'root'],
    })
  })

  it('walks an ordinary fork chain without subagent origins', async () => {
    const { resolver } = resolverFor({
      root: { id: 'root' },
      fork: { id: 'fork', parentSession: 'root' },
      grandchild: { id: 'grandchild', parentSession: 'fork' },
    })
    await expect(resolver.resolve('grandchild')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['grandchild', 'fork', 'root'],
    })
  })

  it('rejects a missing starting header with ADMISSION_UNAVAILABLE', async () => {
    const { resolver } = resolverFor({ root: { id: 'root' } })
    await expect(resolver.resolve('ghost')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('rejects a missing intermediate header with ADMISSION_UNAVAILABLE', async () => {
    const { resolver } = resolverFor({
      child: { id: 'child', parentSession: 'ghost' },
    })
    await expect(resolver.resolve('child')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('fails closed on a cycle', async () => {
    const { resolver } = resolverFor({
      a: { id: 'a', parentSession: 'b' },
      b: { id: 'b', parentSession: 'a' },
    })
    await expect(resolver.resolve('a')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('fails closed on a self-referencing repeated id', async () => {
    const { resolver } = resolverFor({ a: { id: 'a', parentSession: 'a' } })
    await expect(resolver.resolve('a')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('accepts exactly 1,024 headers and rejects 1,025', async () => {
    const buildChain = (count: number) => {
      const headers: Record<string, FakeHeader> = { n0: { id: 'n0' } }
      for (let i = 1; i < count; i += 1) {
        headers[`n${i}`] = { id: `n${i}`, parentSession: `n${i - 1}` }
      }
      return headers
    }

    const atLimit = resolverFor(buildChain(1024))
    const lineage = await atLimit.resolver.resolve('n1023')
    expect(lineage.rootSessionId).toBe('n0')
    expect(lineage.lineage).toHaveLength(1024)
    expect(lineage.lineage[0]).toBe('n1023')
    expect(lineage.lineage[1023]).toBe('n0')

    const pastLimit = resolverFor(buildChain(1025))
    await expect(pastLimit.resolver.resolve('n1024')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('fails closed when the inspected header id does not match the requested id', async () => {
    const reader = {
      inspect: vi.fn(async () => ({ id: 'other' })),
    } satisfies SessionHeaderReader
    const resolver = new DurableRootResolver(reader)
    await expect(resolver.resolve('wanted')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
  })

  it('memoizes every traversed id only after the whole chain succeeds', async () => {
    const { resolver, reader } = resolverFor({
      root: { id: 'root' },
      fork: { id: 'fork', parentSession: 'root' },
      child: { id: 'child', parentSession: 'fork' },
    })

    await expect(resolver.resolve('child')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['child', 'fork', 'root'],
    })
    const callsAfterFirst = reader.inspect.mock.calls.length
    expect(callsAfterFirst).toBe(3)

    await expect(resolver.resolve('fork')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['fork', 'root'],
    })
    await expect(resolver.resolve('root')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['root'],
    })
    await expect(resolver.resolve('child')).resolves.toEqual({
      rootSessionId: 'root',
      lineage: ['child', 'fork', 'root'],
    })
    expect(reader.inspect.mock.calls.length).toBe(callsAfterFirst)
  })

  it('never memoizes a failed or partial traversal', async () => {
    const headers: Record<string, FakeHeader> = {
      a: { id: 'a', parentSession: 'b' },
      b: { id: 'b', parentSession: 'c' },
    }
    const { resolver, reader } = resolverFor(headers)

    await expect(resolver.resolve('a')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
    expect(reader.inspect.mock.calls.length).toBe(3)

    headers.c = { id: 'c' }
    await expect(resolver.resolve('a')).resolves.toEqual({
      rootSessionId: 'c',
      lineage: ['a', 'b', 'c'],
    })
    expect(reader.inspect.mock.calls.length).toBe(6)
  })

  it('does not let caller mutation corrupt memoized lineage', async () => {
    const { resolver } = resolverFor({
      root: { id: 'root' },
      child: { id: 'child', parentSession: 'root' },
    })

    const first = await resolver.resolve('child')
    try {
      ;(first.lineage as string[]).push('evil')
    } catch {
      // frozen lineage: mutation rejected
    }
    try {
      ;(first as { rootSessionId?: string }).rootSessionId = 'evil'
    } catch {
      // frozen result: mutation rejected
    }

    const again = await resolver.resolve('child')
    expect(again).toEqual({ rootSessionId: 'root', lineage: ['child', 'root'] })
  })

  it('exposes only operational ids and code on resolve failures', async () => {
    const { resolver } = resolverFor({
      child: { id: 'child', parentSession: 'ghost', origin: 'subagent' },
    })
    const error = await resolver.resolve('child').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'ADMISSION_UNAVAILABLE', sessionId: 'ghost' })
    expect(Object.keys(error as object).sort()).toEqual(['code', 'sessionId'])
    expect(JSON.stringify(error)).not.toContain('origin')
  })
})

describe('DurableRootResolver.bindChild', () => {
  it('rejects a mismatch between local and expected parent ids', () => {
    const { resolver } = resolverFor({})
    const caught = expectBindingConflict(() =>
      resolver.bindChild({
        childSessionId: 'child',
        expectedParentSessionId: 'fork',
        expectedRootSessionId: 'root',
        localParentSessionId: 'other',
      }),
    )
    expect(Object.keys(caught as object).sort()).toEqual(['childSessionId', 'code'])
    expect(JSON.stringify(caught)).not.toContain('origin')
  })

  it('accepts a matching local parent id and does not mutate caller input', () => {
    const { resolver } = resolverFor({})
    const binding = {
      childSessionId: 'child',
      expectedParentSessionId: 'fork',
      expectedRootSessionId: 'root',
      localParentSessionId: 'fork',
    }
    const before = { ...binding }
    resolver.bindChild(binding)
    expect(binding).toEqual(before)
  })

  it('rejects a resolved parent whose cached durable root disagrees', async () => {
    const { resolver } = resolverFor({
      root: { id: 'root' },
      fork: { id: 'fork', parentSession: 'root' },
    })
    await resolver.resolve('fork')
    expectBindingConflict(() =>
      resolver.bindChild({
        childSessionId: 'child',
        expectedParentSessionId: 'fork',
        expectedRootSessionId: 'other',
      }),
    )
  })

  it('accepts a resolved parent whose cached durable root agrees', async () => {
    const { resolver } = resolverFor({
      root: { id: 'root' },
      fork: { id: 'fork', parentSession: 'root' },
    })
    await resolver.resolve('fork')
    expect(() =>
      resolver.bindChild({
        childSessionId: 'child',
        expectedParentSessionId: 'fork',
        expectedRootSessionId: 'root',
      }),
    ).not.toThrow()
  })

  it('caches the first valid binding, is idempotent for the same root, and rejects a different root', () => {
    const { resolver } = resolverFor({})
    resolver.bindChild({
      childSessionId: 'child',
      expectedParentSessionId: 'parent',
      expectedRootSessionId: 'root',
    })
    expect(() =>
      resolver.bindChild({
        childSessionId: 'child',
        expectedParentSessionId: 'parent',
        expectedRootSessionId: 'root',
      }),
    ).not.toThrow()
    expectBindingConflict(() =>
      resolver.bindChild({
        childSessionId: 'child',
        expectedParentSessionId: 'parent',
        expectedRootSessionId: 'other',
      }),
    )
  })

  it('caches a child or remote run identity for telemetry without inspect or a fabricated durable header', async () => {
    const { resolver, reader } = resolverFor({})
    resolver.bindChild({
      childSessionId: 'run-remote-1',
      expectedParentSessionId: 'parent',
      expectedRootSessionId: 'root',
    })
    expect(reader.inspect).not.toHaveBeenCalled()

    await expect(resolver.resolve('run-remote-1')).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
    })
    expect(reader.inspect).toHaveBeenCalledWith('run-remote-1')
  })
})
