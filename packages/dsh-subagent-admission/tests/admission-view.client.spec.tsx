// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resolveSlotLabel, SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  type ComponentProps,
  type FC,
  type ReactNode,
  useState,
  useSyncExternalStore,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AdmissionControlView,
} from '../src/client/AdmissionControlView.tsx'
import { apply, inject as clientInject } from '../src/client/index.ts'
import {
  en,
  NS,
  type AdmissionControlKey,
} from '../src/client/locales.ts'
import { ensureAdmissionStyles } from '../src/client/styles.ts'
import type { AdmissionSnapshot } from '../src/types.ts'

const SID = 'root' as SessionId

function snapshot(overrides: Partial<AdmissionSnapshot> = {}): AdmissionSnapshot {
  return {
    schemaVersion: 1,
    time: '2026-08-14T00:00:05.000Z',
    epoch: 'epoch-a',
    revision: 7,
    requestedSessionId: SID,
    requestedRootId: SID,
    mode: 'strict',
    enforced: true,
    reason: null,
    limits: {
      globalActive: 6,
      perRootActive: 4,
      perRootAdmittedTotal: 24,
      perParentChildren: 8,
    },
    usage: {
      globalActive: 2,
      rootActive: 2,
      rootAdmittedTotal: 9,
      parentChildren: 1,
    },
    leases: [{
      childSessionId: 'child-a',
      parentSessionId: SID,
      rootId: SID,
      operation: 'new-continuable',
      mode: 'strict',
      admittedAt: '2026-08-14T00:00:01.000Z',
      phase: 'active',
    }, {
      childSessionId: null,
      parentSessionId: SID,
      rootId: SID,
      operation: 'new-one-shot',
      mode: 'strict',
      admittedAt: '2026-08-14T00:00:02.000Z',
      phase: 'draining',
    }],
    history: [{
      kind: 'accepted',
      time: '2026-08-14T00:00:01.000Z',
      requestId: 'request-a',
      operation: 'new-continuable',
      rootId: SID,
      parentSessionId: SID,
      code: null,
    }, {
      kind: 'denied',
      time: '2026-08-14T00:00:03.000Z',
      requestId: 'request-b',
      operation: 'cold-resume',
      rootId: SID,
      parentSessionId: SID,
      code: 'ROOT_ACTIVE_LIMIT',
    }],
    droppedHistory: 0,
    ...overrides,
  }
}

function english(key: AdmissionControlKey): string {
  return en[key]
}

function propsFor(
  value: AdmissionSnapshot | null,
): ComponentProps<typeof AdmissionControlView> {
  return {
    sessionId: SID,
    t: english,
    useAdmission: selector => selector(value),
  } as ComponentProps<typeof AdmissionControlView>
}

function resolveLabel(label: StoredEntry['options']['label'], fallback: string): string {
  return resolveSlotLabel(label) ?? fallback
}

afterEach(() => {
  cleanup()
  for (const style of document.querySelectorAll('style[data-plugin="dsh-subagent-admission"]')) {
    style.remove()
  }
})

describe('AdmissionControlView semantics', () => {
  it('renders status, all four quotas, leases, and history without mutation controls', () => {
    render(<AdmissionControlView {...propsFor(snapshot())} />)

    expect(screen.getByRole('status')).toHaveTextContent('Strict')
    expect(screen.getByRole('status')).toHaveTextContent('Protocol-backed admission is enforced.')
    expect(screen.getByLabelText('Strict status')).toHaveTextContent('✓')
    expect(screen.getByText('Yes')).toBeVisible()
    expect(screen.getAllByTestId('quota-card')).toHaveLength(4)
    expect(screen.getByText('2 / 6')).toBeVisible()
    expect(screen.getByText('2 / 4')).toBeVisible()
    expect(screen.getByText('9 / 24')).toBeVisible()
    expect(screen.getByText('1 / 8')).toBeVisible()
    expect(screen.getByRole('table', { name: 'Active leases' })).toBeVisible()
    expect(screen.getByRole('table', { name: 'Admission history' })).toBeVisible()
    expect(screen.getByText('child-a')).toBeVisible()
    expect(screen.getByText('Pending child publication')).toBeVisible()
    expect(screen.getByText('ROOT_ACTIVE_LIMIT')).toBeVisible()

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    for (const label of ['Kill', 'Reset', 'Force release', 'Retry', 'Edit quota']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it.each([
    ['audit', false, null, 'Audit', 'Observation only; limits are not enforced.', '◉'],
    ['unavailable', false, 'runtime-restarted', 'Unavailable', 'Admission protocol is unavailable.', '!'],
    ['draining', true, 'policy-unloaded', 'Draining', 'New admission is closed while existing permits drain.', '…'],
  ] as const)(
    'renders explicit %s mode text and a non-colour symbol',
    (mode, enforced, reason, label, copy, symbol) => {
      render(<AdmissionControlView {...propsFor(snapshot({ mode, enforced, reason }))} />)

      const status = screen.getByRole('status')
      expect(status).toHaveTextContent(label)
      expect(status).toHaveTextContent(copy)
      if (reason !== null) expect(screen.getByText(reason)).toBeVisible()
      expect(screen.getByLabelText(`${label} status`)).toHaveTextContent(symbol)
    },
  )

  it('renders loading and empty states plus an explicit dropped-history warning', () => {
    const { rerender } = render(<AdmissionControlView {...propsFor(null)} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading admission snapshot')

    rerender(<AdmissionControlView {...propsFor(snapshot({
      leases: [],
      history: [],
      droppedHistory: 12,
    }))} />)
    expect(screen.getByText('No active leases.')).toBeVisible()
    expect(screen.getByText('No admission events recorded.')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('12 older events were dropped')
  })
})

describe('Admission Control style ownership', () => {
  it('shares one owned style and removes only that node after the final disposer', () => {
    const foreign = document.createElement('style')
    foreign.dataset.plugin = 'another-plugin'
    document.head.append(foreign)

    const disposeFirst = ensureAdmissionStyles()
    const disposeSecond = ensureAdmissionStyles()
    expect(document.querySelectorAll('style[data-plugin="dsh-subagent-admission"]')).toHaveLength(1)

    disposeFirst()
    expect(document.querySelector('style[data-plugin="dsh-subagent-admission"]')).not.toBeNull()
    disposeSecond()
    expect(document.querySelector('style[data-plugin="dsh-subagent-admission"]')).toBeNull()
    expect(foreign.isConnected).toBe(true)
    foreign.remove()
  })
})

interface RingHarnessProps {
  readonly slots: TestSlots
  readonly admissionView: FC<ComponentProps<typeof AdmissionControlView>>
  readonly admissionProps: ComponentProps<typeof AdmissionControlView>
}

/** Thin lifecycle adapter around DSH's authoritative pure SlotCore ledger. */
class TestSlots {
  private readonly core = new SlotCore()

  register(options: object, component: unknown): () => void {
    return this.core.register(options as never, component as never)
  }

  inject(key: string, install: () => () => void): () => void {
    if (this.core.specDynamic(key) === undefined) {
      throw new Error(`test slot ${JSON.stringify(key)} is not declared`)
    }
    const dispose = install()
    let active = true
    return () => {
      if (!active) return
      active = false
      dispose()
    }
  }

  entries(key: string): readonly StoredEntry[] {
    return this.core.entries(key)
  }

  subscribe(key: string, listener: () => void): () => void {
    return this.core.subscribe(key, listener)
  }

  getVersion(key: string): number {
    return this.core.getVersion(key)
  }
}

/** Stable-thunk locale contract used by the production registration path. */
class TestLocale {
  private active: 'zh' | 'en' = 'en'
  private readonly dictionaries = new Map<string, Record<'zh' | 'en', Record<string, string>>>()

  register(
    namespace: string,
    dictionaries: Record<'zh' | 'en', Record<string, string>>,
  ): () => void {
    if (this.dictionaries.has(namespace)) throw new Error(`duplicate locale ${namespace}`)
    this.dictionaries.set(namespace, dictionaries)
    return () => { this.dictionaries.delete(namespace) }
  }

  bind(namespace: string): (key: string) => string {
    return key => this.dictionaries.get(namespace)?.[this.active][key] ?? key
  }

  setLocale(locale: 'zh' | 'en'): void {
    this.active = locale
  }
}

/** Minimal consumer of the actual ordered SlotCore ledger and native tab semantics. */
function RingHarness({ slots, admissionView: AdmissionView, admissionProps }: RingHarnessProps) {
  useSyncExternalStore(
    listener => slots.subscribe('conversation.view', listener),
    () => slots.getVersion('conversation.view'),
  )
  const entries = slots.entries('conversation.view')
  const [active, setActive] = useState('chat')
  let body: ReactNode = <div data-testid="chat-body">Chat body</div>
  if (active === 'admission-control') body = <AdmissionView {...admissionProps} />

  return (
    <>
      <div role="tablist" aria-label="Conversation views">
        {entries.map(entry => (
          <button
            aria-selected={entry.options.id === active}
            key={entry.options.id}
            onClick={() => { setActive(entry.options.id!) }}
            role="tab"
            type="button"
          >
            {resolveLabel(entry.options.label, entry.options.id!)}
          </button>
        ))}
      </div>
      {body}
    </>
  )
}

describe('native conversation.view registration', () => {
  it('is additive, bilingual, keyboard reachable, and fully removed on plugin disposal', async () => {
    const events: string[] = []
    const slots = new TestSlots()
    slots.register({
      name: 'root',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, (() => null) as never)
    slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: 'Chat',
    } as never, (() => null) as never)

    const locale = new TestLocale()
    let watchSignal: AbortSignal | undefined
    const get = vi.fn(async () => ({ ok: true as const, value: snapshot() }))
    const watch = vi.fn(async (_request: unknown, signal?: AbortSignal) => {
      watchSignal = signal
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    })
    const disposeRemote = vi.fn(async () => { events.push('remote-unmounted') })
    let ctx!: ClientContext
    const injectService = vi.fn((_deps: readonly string[], callback: (scope: ClientContext) => unknown) => {
      let disposeFeature: () => void | Promise<void> = () => {}
      const ready = Promise.resolve().then(() => callback(ctx)).then((dispose) => {
        if (typeof dispose === 'function') disposeFeature = dispose as () => void | Promise<void>
      })
      return {
        await: async () => { await ready },
        dispose: async () => { await ready; await disposeFeature() },
      }
    })
    ctx = {
      locale,
      slots,
      sessions: {},
      remote: {
        $mount: vi.fn(async () => disposeRemote),
        snapshot: { get, watch },
      },
      inject: injectService,
    } as unknown as ClientContext

    expect(clientInject).toEqual(['remote', 'slots', 'locale', 'sessions'])
    const disposePlugin = await apply(ctx)
    expect(injectService).toHaveBeenCalledWith(
      ['remote.snapshot', 'slots', 'locale', 'sessions'],
      expect.any(Function),
    )

    const ids = slots.entries('conversation.view').map(entry => entry.options.id)
    expect(ids).toEqual(['chat', 'admission-control'])
    const entry = slots.entries('conversation.view').find(
      candidate => candidate.options.id === 'admission-control',
    )!
    expect(entry.options.order).toBe(20)
    expect(resolveLabel(entry.options.label, entry.options.id!)).toBe('Admission Control')
    locale.setLocale('zh')
    expect(resolveLabel(entry.options.label, entry.options.id!)).toBe('准入控制')
    locale.setLocale('en')

    const injected = (entry.inject as (sessionId: SessionId) => {
      hooks: {
        admission: {
          getSnapshot(): AdmissionSnapshot | null
          subscribe(listener: () => void): () => void
        }
      }
    })(SID)
    const useAdmission: ComponentProps<typeof AdmissionControlView>['useAdmission'] = selector => {
      const value = useSyncExternalStore(
        injected.hooks.admission.subscribe,
        injected.hooks.admission.getSnapshot,
      )
      return selector(value)
    }
    render(<RingHarness
      admissionProps={{
        ...({ sessionId: SID } as ConvViewProps),
        t: locale.bind(NS),
        useAdmission,
      } as ComponentProps<typeof AdmissionControlView>}
      admissionView={AdmissionControlView}
      slots={slots}
    />)

    const user = userEvent.setup()
    expect(screen.getByTestId('chat-body')).toBeVisible()
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Admission Control' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Strict')
    await vi.waitFor(() => expect(watchSignal).toBeDefined())
    expect(document.querySelector('style[data-plugin="dsh-subagent-admission"]')).not.toBeNull()

    await disposePlugin()
    events.push('plugin-disposed')
    expect(watchSignal?.aborted).toBe(true)
    expect(slots.entries('conversation.view').map(candidate => candidate.options.id)).toEqual(['chat'])
    expect(document.querySelector('style[data-plugin="dsh-subagent-admission"]')).toBeNull()
    expect(disposeRemote).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['remote-unmounted', 'plugin-disposed'])
  })
})
