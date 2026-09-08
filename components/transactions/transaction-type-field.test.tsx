import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TransactionType } from '@prisma/client'
import { TransactionTypeField } from './transaction-type-field'

/**
 * Fix round 2 regression guard: collapsing "Khác" while an Other-type value
 * was checked used to drop the checked radio out of `visibleTypes` entirely
 * — no rendered radio was checked, so every one got `tabIndex=-1` and the
 * `role="radiogroup"` had zero tab stops. `renderToStaticMarkup` is enough to
 * pin this down (no jsdom, no Testing Library — the repo convention): the
 * defect is entirely about which BYTES the server emits, never about a click.
 */
const LABELS: Record<TransactionType, string> = {
  INCOME: 'Income',
  EXPENSE: 'Expense',
  CASH_IN: 'Cash In (other)',
  CASH_OUT: 'Cash Out (other)',
  ADJUSTMENT_INCREASE: 'Balance Adjustment — increase',
  ADJUSTMENT_DECREASE: 'Balance Adjustment — decrease',
}

function render(value: TransactionType): string {
  return renderToStaticMarkup(
    <TransactionTypeField
      value={value}
      onChange={vi.fn()}
      labels={LABELS}
      legend="Transaction type"
      otherLabel="Other"
    />,
  )
}

/** The markup of the radiogroup itself — see `transaction-form.test.tsx`'s
 *  identical helper for why the first `</div>` after the opening tag is
 *  exactly the group's own closing tag. */
function radiogroupMarkup(html: string): string {
  const start = html.indexOf('role="radiogroup"')
  if (start === -1) throw new Error('No radiogroup in the markup')
  const end = html.indexOf('</div>', start)
  return html.slice(start, end)
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1
}

/** The markup of the one `<button>` containing `needle`, found the same way
 *  `transaction-form.test.tsx`'s `selectMarkup` scopes a `<select>`. */
function buttonMarkupContaining(html: string, needle: string): string {
  const idx = html.indexOf(needle)
  if (idx === -1) throw new Error(`"${needle}" not found in the markup`)
  const start = html.lastIndexOf('<button', idx)
  const end = html.indexOf('</button>', idx)
  if (start === -1 || end === -1) throw new Error(`No <button> around "${needle}"`)
  return html.slice(start, end + '</button>'.length)
}

describe('TransactionTypeField', () => {
  it('keeps exactly one tab stop when an Other-type value is checked, with every option rendered', () => {
    const html = render('ADJUSTMENT_INCREASE')
    const group = radiogroupMarkup(html)

    // The disclosure is forced open by the checked value (fix round 2, fix
    // (a)) — all six radios are in the group, not just the two primary ones.
    for (const label of Object.values(LABELS)) {
      expect(group).toContain(label)
    }

    // Exactly one tab stop, and it is the CHECKED radio's own button — not
    // merely "some button somewhere", which a miscounted `tabIndex` could
    // still satisfy by accident.
    expect(countOf(group, 'tabindex="0"')).toBe(1)
    const tabStopButton = buttonMarkupContaining(group, 'tabindex="0"')
    expect(tabStopButton).toContain('aria-checked="true"')
    expect(tabStopButton).toContain(LABELS.ADJUSTMENT_INCREASE)

    // The "Khác" toggle is disabled while this value is checked, so there is
    // no control left that could re-collapse the group out from under it.
    expect(html).toMatch(/aria-expanded="true"[^>]*disabled=""/)
  })

  it('keeps exactly one tab stop for the default EXPENSE value, with only the primary options rendered', () => {
    const html = render('EXPENSE')
    const group = radiogroupMarkup(html)

    expect(group).toContain(LABELS.EXPENSE)
    expect(group).toContain(LABELS.INCOME)
    // Collapsed by default: the four "other" radios are not rendered at all.
    expect(group).not.toContain(LABELS.CASH_IN)
    expect(group).not.toContain(LABELS.ADJUSTMENT_INCREASE)

    expect(countOf(group, 'tabindex="0"')).toBe(1)
    const tabStopButton = buttonMarkupContaining(group, 'tabindex="0"')
    expect(tabStopButton).toContain('aria-checked="true"')
    expect(tabStopButton).toContain(LABELS.EXPENSE)
  })
})
