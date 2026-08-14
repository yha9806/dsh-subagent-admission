/** Compact native-view styling owned by the Admission Control plugin. */

const STYLE_SELECTOR = 'style[data-plugin="dsh-subagent-admission"]'

const ADMISSION_CONTROL_CSS = `
.dsh-admission {
  box-sizing: border-box;
  color: var(--foreground, inherit);
  display: grid;
  gap: 0.75rem;
  margin: 0 auto;
  max-width: 1120px;
  padding: 0.75rem 1rem;
  width: 100%;
}
.dsh-admission *, .dsh-admission *::before, .dsh-admission *::after { box-sizing: border-box; }
.dsh-admission h1, .dsh-admission h2, .dsh-admission p, .dsh-admission dl { margin: 0; }
.dsh-admission__title { font-size: 1.15rem; font-weight: 650; letter-spacing: -0.01em; }
.dsh-admission__section {
  background: var(--card, rgba(127, 127, 127, 0.05));
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 0.75rem;
  display: grid;
  gap: 0.55rem;
  padding: 0.7rem 0.875rem;
}
.dsh-admission__section-title { font-size: 0.9rem; font-weight: 650; }
.dsh-admission__status-line { align-items: flex-start; display: flex; gap: 0.75rem; }
.dsh-admission__status-symbol {
  align-items: center;
  border: 1px solid currentColor;
  border-radius: 999px;
  display: inline-flex;
  flex: 0 0 1.8rem;
  font-weight: 750;
  height: 1.8rem;
  justify-content: center;
}
.dsh-admission__status-label { display: block; font-size: 1rem; font-weight: 700; }
.dsh-admission__status-summary { color: var(--muted-foreground, #6b7280); margin-top: 0.125rem; }
.dsh-admission__status--strict { color: var(--success-foreground, #177245); }
.dsh-admission__status--audit { color: var(--warning-foreground, #8a5a00); }
.dsh-admission__status--unavailable { color: var(--destructive, #b42318); }
.dsh-admission__status--draining { color: var(--warning-foreground, #8a5a00); }
.dsh-admission__reason { overflow-wrap: anywhere; }
.dsh-admission__meta { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
.dsh-admission__meta div { display: flex; gap: 0.35rem; min-width: 0; }
.dsh-admission__meta dt { color: var(--muted-foreground, #6b7280); }
.dsh-admission__meta dd { margin: 0; overflow-wrap: anywhere; }
.dsh-admission__quota-grid { display: grid; gap: 0.625rem; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.dsh-admission__quota-card {
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 0.6rem;
  display: grid;
  gap: 0.3rem;
  min-width: 0;
  padding: 0.5rem 0.65rem;
}
.dsh-admission__quota-label { color: var(--muted-foreground, #6b7280); font-size: 0.78rem; }
.dsh-admission__quota-value { font-size: 1rem; font-variant-numeric: tabular-nums; font-weight: 700; }
.dsh-admission__table-wrap { overflow-x: auto; }
.dsh-admission__table { border-collapse: collapse; font-size: 0.78rem; line-height: 1.25; min-width: 700px; width: 100%; }
.dsh-admission__table th, .dsh-admission__table td {
  border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.22));
  padding: 0.32rem 0.5rem;
  text-align: left;
  vertical-align: top;
}
.dsh-admission__table th { color: var(--muted-foreground, #6b7280); font-weight: 600; white-space: nowrap; }
.dsh-admission__table code { font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.dsh-admission__empty { color: var(--muted-foreground, #6b7280); font-size: 0.85rem; }
.dsh-admission__warning {
  background: var(--warning-muted, rgba(217, 119, 6, 0.12));
  border-left: 3px solid var(--warning-foreground, #8a5a00);
  border-radius: 0.3rem;
  padding: 0.55rem 0.65rem;
}
@media (max-width: 820px) {
  .dsh-admission__quota-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .dsh-admission { padding: 0.7rem; }
  .dsh-admission__quota-grid { grid-template-columns: 1fr; }
}
`

interface OwnedStyle {
  readonly element: HTMLStyleElement
  references: number
}

const ownedStyles = new WeakMap<Document, OwnedStyle>()

/**
 * Acquire the plugin's one document-scoped style node.
 *
 * Repeated acquisitions share ownership. A selector collision that was not
 * created by this module fails closed instead of adopting and later deleting
 * another plugin's node.
 */
export function ensureAdmissionStyles(target: Document = document): () => void {
  const current = ownedStyles.get(target)
  if (current?.element.isConnected === true) {
    current.references += 1
    return styleDisposer(target, current)
  }
  if (current !== undefined) ownedStyles.delete(target)
  if (target.querySelector(STYLE_SELECTOR) !== null) {
    throw new Error('dsh-subagent-admission style ownership collision')
  }

  const element = target.createElement('style')
  element.dataset.plugin = 'dsh-subagent-admission'
  element.textContent = ADMISSION_CONTROL_CSS
  target.head.append(element)
  const owned: OwnedStyle = { element, references: 1 }
  ownedStyles.set(target, owned)
  return styleDisposer(target, owned)
}

function styleDisposer(target: Document, owned: OwnedStyle): () => void {
  let active = true
  return () => {
    if (!active) return
    active = false
    if (ownedStyles.get(target) !== owned) return
    owned.references -= 1
    if (owned.references > 0) return
    ownedStyles.delete(target)
    owned.element.remove()
  }
}
