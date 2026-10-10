import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { CashFlowTrendChart } from './lazy-charts'

/**
 * Markup tests, like `debt-loan-overview.test.tsx`: no jsdom, no new dependency.
 *
 * What is worth pinning down is the performance contract, not recharts: the
 * server (and the first client paint, before the chart chunk arrives) renders a
 * grey placeholder that fills `ChartContainer`'s fixed-height body, and the
 * dashboard page never imports a chart module — or recharts — statically.
 */
describe('lazy dashboard charts', () => {
  it('server-renders a full-size, aria-hidden skeleton instead of the chart', () => {
    const html = renderToStaticMarkup(
      <CashFlowTrendChart
        data={[{ label: 'Sep', income: 1, expense: 1, netIncome: 0 }]}
        currency="VND"
        locale="en"
        height={300}
        summary="summary"
        seriesLabels={{ income: 'Income', expense: 'Expense', netIncome: 'Net' }}
      />,
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('h-full w-full')
    // No plot, no figure, and not a list: e2e specs pick the first listitem.
    expect(html).not.toMatch(/<figure|<svg|<ul|<li/)
  })

  it('keeps recharts out of the dashboard page (no static chart imports)', () => {
    const page = readFileSync('app/(app)/dashboard/page.tsx', 'utf8')
    expect(page).not.toMatch(/from '@\/components\/dashboard\/[a-z-]+-chart'/)
    expect(page).not.toMatch(/from 'recharts'/)
    expect(page).toContain("from '@/components/dashboard/lazy-charts'")
  })
})
