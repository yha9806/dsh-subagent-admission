/** Native read-only conversation view for admission state and bounded history. */

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type {
  AdmissionEvent,
  AdmissionEventKind,
  AdmissionLease,
  AdmissionLeasePhase,
  AdmissionMode,
  AdmissionOperation,
  AdmissionSnapshot,
} from '../types.js'
import type { AdmissionControllerInjection } from './controller.js'
import { NS, type AdmissionControlKey } from './locales.js'

export type AdmissionControlViewProps = ConvViewProps
  & InjectFace<AdmissionControllerInjection>
  & PropsLocale<typeof NS>

type Translate = AdmissionControlViewProps['t']

interface StatusCopy {
  readonly aria: AdmissionControlKey
  readonly label: AdmissionControlKey
  readonly summary: AdmissionControlKey
  readonly symbol: string
}

function statusCopy(mode: AdmissionMode): StatusCopy {
  switch (mode) {
    case 'strict': return {
      aria: 'status.strict.aria',
      label: 'status.strict.label',
      summary: 'status.strict.summary',
      symbol: '✓',
    }
    case 'audit': return {
      aria: 'status.audit.aria',
      label: 'status.audit.label',
      summary: 'status.audit.summary',
      symbol: '◉',
    }
    case 'unavailable': return {
      aria: 'status.unavailable.aria',
      label: 'status.unavailable.label',
      summary: 'status.unavailable.summary',
      symbol: '!',
    }
    case 'draining': return {
      aria: 'status.draining.aria',
      label: 'status.draining.label',
      summary: 'status.draining.summary',
      symbol: '…',
    }
  }
}

function operationLabel(operation: AdmissionOperation, t: Translate): string {
  return t(`operation.${operation}`)
}

function modeLabel(mode: AdmissionMode, t: Translate): string {
  return t(`status.${mode}.label`)
}

function phaseLabel(phase: AdmissionLeasePhase, t: Translate): string {
  return t(`phase.${phase}`)
}

function eventLabel(kind: AdmissionEventKind, t: Translate): string {
  return t(`event.${kind}`)
}

function fallback(value: string | null, t: Translate): string {
  return value ?? t('value.none')
}

function PolicyStatus({ snapshot, t }: {
  readonly snapshot: AdmissionSnapshot | null
  readonly t: Translate
}) {
  if (snapshot === null) {
    return (
      <section className="dsh-admission__section" aria-labelledby="admission-policy-title">
        <h2 className="dsh-admission__section-title" id="admission-policy-title">
          {t('status.title')}
        </h2>
        <div className="dsh-admission__status-line" role="status">
          <span
            aria-label={t('snapshot.loading')}
            className="dsh-admission__status-symbol"
            role="img"
          >
            …
          </span>
          <p>{t('snapshot.loading')}</p>
        </div>
      </section>
    )
  }

  const copy = statusCopy(snapshot.mode)
  return (
    <section className="dsh-admission__section" aria-labelledby="admission-policy-title">
      <h2 className="dsh-admission__section-title" id="admission-policy-title">
        {t('status.title')}
      </h2>
      <div className={`dsh-admission__status-line dsh-admission__status--${snapshot.mode}`} role="status">
        <span
          aria-label={t(copy.aria)}
          className="dsh-admission__status-symbol"
          role="img"
        >
          {copy.symbol}
        </span>
        <div>
          <span className="dsh-admission__status-label">{t(copy.label)}</span>
          <p className="dsh-admission__status-summary">{t(copy.summary)}</p>
        </div>
      </div>
      {snapshot.reason === null ? null : (
        <p className="dsh-admission__reason">
          <strong>{t('status.reason')}:</strong> <code>{snapshot.reason}</code>
        </p>
      )}
      <dl className="dsh-admission__meta">
        <div><dt>{t('snapshot.enforced')}</dt><dd>{t(snapshot.enforced ? 'value.yes' : 'value.no')}</dd></div>
        <div><dt>{t('snapshot.epoch')}</dt><dd><code>{snapshot.epoch}</code></dd></div>
        <div><dt>{t('snapshot.revision')}</dt><dd>{snapshot.revision}</dd></div>
        <div><dt>{t('snapshot.updated')}</dt><dd><time dateTime={snapshot.time}>{snapshot.time}</time></dd></div>
      </dl>
    </section>
  )
}

function QuotaGrid({ snapshot, t }: {
  readonly snapshot: AdmissionSnapshot | null
  readonly t: Translate
}) {
  const cards: readonly [AdmissionControlKey, number | null, number | null][] = [
    ['quota.globalActive', snapshot?.usage.globalActive ?? null, snapshot?.limits.globalActive ?? null],
    ['quota.rootActive', snapshot?.usage.rootActive ?? null, snapshot?.limits.perRootActive ?? null],
    [
      'quota.rootAdmittedTotal',
      snapshot?.usage.rootAdmittedTotal ?? null,
      snapshot?.limits.perRootAdmittedTotal ?? null,
    ],
    [
      'quota.parentChildren',
      snapshot?.usage.parentChildren ?? null,
      snapshot?.limits.perParentChildren ?? null,
    ],
  ]
  return (
    <section className="dsh-admission__section" aria-labelledby="admission-capacity-title">
      <h2 className="dsh-admission__section-title" id="admission-capacity-title">{t('quota.title')}</h2>
      <div className="dsh-admission__quota-grid">
        {cards.map(([label, usage, limit]) => (
          <article className="dsh-admission__quota-card" data-testid="quota-card" key={label}>
            <span className="dsh-admission__quota-label">{t(label)}</span>
            <span className="dsh-admission__quota-value">
              {usage ?? t('value.none')} / {limit ?? t('value.none')}
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}

function LeaseRow({ lease, t }: { readonly lease: AdmissionLease; readonly t: Translate }) {
  return (
    <tr>
      <td><code>{lease.childSessionId ?? t('leases.pendingChild')}</code></td>
      <td><code>{lease.parentSessionId}</code></td>
      <td><code>{lease.rootId}</code></td>
      <td>{operationLabel(lease.operation, t)}</td>
      <td>{modeLabel(lease.mode, t)}</td>
      <td><time dateTime={lease.admittedAt}>{lease.admittedAt}</time></td>
      <td>{phaseLabel(lease.phase, t)}</td>
    </tr>
  )
}

function ActiveLeaseTable({ leases, t }: {
  readonly leases: readonly AdmissionLease[]
  readonly t: Translate
}) {
  return (
    <section className="dsh-admission__section" aria-labelledby="admission-leases-title">
      <h2 className="dsh-admission__section-title" id="admission-leases-title">{t('leases.title')}</h2>
      {leases.length === 0 ? <p className="dsh-admission__empty">{t('leases.empty')}</p> : (
        <div className="dsh-admission__table-wrap">
          <table aria-label={t('leases.aria')} className="dsh-admission__table">
            <thead><tr>
              <th scope="col">{t('leases.child')}</th>
              <th scope="col">{t('leases.parent')}</th>
              <th scope="col">{t('leases.root')}</th>
              <th scope="col">{t('leases.operation')}</th>
              <th scope="col">{t('leases.mode')}</th>
              <th scope="col">{t('leases.admittedAt')}</th>
              <th scope="col">{t('leases.phase')}</th>
            </tr></thead>
            <tbody>{leases.map((lease, index) => (
              <LeaseRow key={`${lease.parentSessionId}:${lease.admittedAt}:${index}`} lease={lease} t={t} />
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function HistoryRow({ event, t }: { readonly event: AdmissionEvent; readonly t: Translate }) {
  return (
    <tr>
      <td><time dateTime={event.time}>{event.time}</time></td>
      <td>{eventLabel(event.kind, t)}</td>
      <td>{event.operation === null ? t('value.none') : operationLabel(event.operation, t)}</td>
      <td><code>{fallback(event.parentSessionId, t)}</code></td>
      <td><code>{fallback(event.code, t)}</code></td>
    </tr>
  )
}

function AdmissionHistory({ events, dropped, t }: {
  readonly events: readonly AdmissionEvent[]
  readonly dropped: number
  readonly t: Translate
}) {
  return (
    <section className="dsh-admission__section" aria-labelledby="admission-history-title">
      <h2 className="dsh-admission__section-title" id="admission-history-title">{t('history.title')}</h2>
      {dropped > 0 ? (
        <p className="dsh-admission__warning" role="alert">
          {dropped} {t('history.droppedSuffix')}
        </p>
      ) : null}
      {events.length === 0 ? <p className="dsh-admission__empty">{t('history.empty')}</p> : (
        <div className="dsh-admission__table-wrap">
          <table aria-label={t('history.aria')} className="dsh-admission__table">
            <thead><tr>
              <th scope="col">{t('history.time')}</th>
              <th scope="col">{t('history.event')}</th>
              <th scope="col">{t('history.operation')}</th>
              <th scope="col">{t('history.parent')}</th>
              <th scope="col">{t('history.code')}</th>
            </tr></thead>
            <tbody>{events.map((event, index) => (
              <HistoryRow key={`${event.time}:${event.kind}:${event.requestId ?? index}`} event={event} t={t} />
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Four-section operational view. It accepts no write callback or mutation face. */
export function AdmissionControlView({ t, useAdmission }: AdmissionControlViewProps) {
  const snapshot = useAdmission(value => value)
  return (
    <section aria-labelledby="admission-control-title" className="dsh-admission">
      <h1 className="dsh-admission__title" id="admission-control-title">{t('view.title')}</h1>
      <PolicyStatus snapshot={snapshot} t={t} />
      <QuotaGrid snapshot={snapshot} t={t} />
      <ActiveLeaseTable leases={snapshot?.leases ?? []} t={t} />
      <AdmissionHistory
        dropped={snapshot?.droppedHistory ?? 0}
        events={snapshot?.history ?? []}
        t={t}
      />
    </section>
  )
}
