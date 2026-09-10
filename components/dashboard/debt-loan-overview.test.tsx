import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { DebtLoanOverview } from './debt-loan-overview'

/**
 * A markup test, like `components/goals/goal-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * This widget is a server component with no state, no client boundary and no
 * arithmetic: every figure it renders is already a formatted string from
 * `buildDashboardViewModel`. So what is worth pinning down is exactly what the
 * markup says — that the three terms are named and *labelled as a definition
 * list* (a figure without its term is unreadable), that each one carries the
 * tone its meaning demands, and that the footnote tells the reader why these
 * three numbers are on a dashboard whose other figures are balances.
 */

const DATA = { receivables: '2.500.000', payables: '750.000', loanOutstanding: '18.000.000' }
const LABELS = {
  'dashboard.receivables': 'Receivables',
  'dashboard.payables': 'Payables',
  'dashboard.loanOutstanding': 'Outstanding loans',
}
const FOOTNOTE = 'Included in Net Worth'

function render(): string {
  return renderToStaticMarkup(
    <DebtLoanOverview data={DATA} currency="VND" labels={LABELS} footnote={FOOTNOTE} />,
  )
}

/** The markup between a `dt` and the `dd` that follows it — one row of the
 *  list, found by the term the reader sees. */
function row(html: string, term: string): string {
  const start = html.indexOf(`>${term}<`)
  if (start === -1) throw new Error(`No term "${term}" in the markup`)
  const end = html.indexOf('</dd>', start)
  if (end === -1) throw new Error(`No <dd> after the term "${term}"`)
  return html.slice(start, end)
}

describe('DebtLoanOverview', () => {
  it('names all three terms in one definition list', () => {
    const html = render()

    expect(html).toContain('<dl')
    expect(html).toContain('>Receivables<')
    expect(html).toContain('>Payables<')
    expect(html).toContain('>Outstanding loans<')
    // Three terms, three descriptions — never a figure without its label.
    expect(html.match(/<dt/g)).toHaveLength(3)
    expect(html.match(/<dd/g)).toHaveLength(3)
  })

  it('renders each figure already formatted, beside the display currency', () => {
    const html = render()

    expect(row(html, 'Receivables')).toContain('2.500.000')
    expect(row(html, 'Payables')).toContain('750.000')
    expect(row(html, 'Outstanding loans')).toContain('18.000.000')
    // The unit once per row, because the three are read as a column.
    expect(html.match(/>VND</g)).toHaveLength(3)
  })

  it('tones an asset positive and both liabilities negative', () => {
    const html = render()

    expect(row(html, 'Receivables')).toContain('text-positive')
    expect(row(html, 'Payables')).toContain('text-negative')
    expect(row(html, 'Outstanding loans')).toContain('text-negative')
    // Colour is never the only signal: each row is named in words too, which
    // the case above asserts.
    expect(row(html, 'Receivables')).not.toContain('text-negative')
  })

  it('aligns the digits so the column can be compared', () => {
    const html = render()

    expect(row(html, 'Receivables')).toContain('tabular-nums')
    expect(row(html, 'Payables')).toContain('tabular-nums')
    expect(row(html, 'Outstanding loans')).toContain('tabular-nums')
  })

  it('says where these three figures went', () => {
    // Without this line the widget is three numbers with no relationship to the
    // Net Worth card above it — which is the one thing the reader needs.
    expect(render()).toContain('Included in Net Worth')
  })
})
