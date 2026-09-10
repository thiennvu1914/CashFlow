import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { CategoryBars } from './category-bars'

const ROWS = [
  { id: 'c1', name: 'Travel', amount: '4.400.000', percent: 100, percentLabel: '25 %' },
  { id: 'c2', name: 'Groceries', amount: '1.720.000', percent: 39, percentLabel: '10 %' },
]

describe('CategoryBars', () => {
  it('renders each bar as decorative — aria-hidden, no progressbar role or aria-value* (fix round 1)', () => {
    // The bar's width is a share of the LARGEST row while the figure beside
    // it is a share of the TOTAL — two different percentages of the same
    // row, which a real `role="progressbar"` cannot honestly announce as one
    // quantity. The visible name/amount/percent carry the meaning instead.
    const html = renderToStaticMarkup(<CategoryBars rows={ROWS} currency="VND" />)
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('aria-valuenow')
    expect(html).not.toContain('aria-valuetext')
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(ROWS.length)
  })

  it('uses the accent tone, not brand — a breakdown is neutral, not a judgement', () => {
    const html = renderToStaticMarkup(<CategoryBars rows={ROWS} currency="VND" />)
    expect(html).toContain('bg-accent')
    expect(html).not.toContain('bg-brand')
  })

  it("still shows every row's name, amount and percent as real text", () => {
    const html = renderToStaticMarkup(<CategoryBars rows={ROWS} currency="VND" />)
    for (const row of ROWS) {
      expect(html).toContain(row.name)
      expect(html).toContain(row.amount)
      expect(html).toContain(row.percentLabel)
    }
  })
})
