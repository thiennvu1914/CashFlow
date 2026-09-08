import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { FinancialListRow } from './financial-list-row'
import { MoneyText } from './money-text'

describe('FinancialListRow', () => {
  it('gives the amount a fixed column so a long note can never push it out', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow
        title="Ăn uống"
        meta="Cash · 12:40"
        note={'x'.repeat(300)}
        amount={<MoneyText value="200.000" currency="VND" sign="−" tone="negative" />}
      />,
    )
    expect(html).toContain('min-w-[8.5rem]')
    expect(html).toContain('200.000')
  })

  it('keeps the whole note in `title` while showing one ellipsised line', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow title="Ăn uống" note="Bữa trưa với khách hàng" amount={<span>1</span>} />,
    )
    expect(html).toContain('title="Bữa trưa với khách hàng"')
    expect(html).toContain('truncate')
  })

  it('renders no note element at all when there is none', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow title="Ăn uống" note={null} amount={<span>1</span>} />,
    )
    expect(html).not.toContain('title="')
    expect(html).not.toContain('undefined')
  })

  it('defaults title and meta to a single ellipsised line — unchanged for existing callers', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow title="Cash → Bank" meta="21:20 · rate" amount={<span>1</span>} />,
    )
    // Two `truncate`s: one for the title, one for the meta. Neither `wrapTitle`
    // nor `wrapMeta` was passed, so both keep the one-line-with-ellipsis
    // behaviour Transactions and the Dashboard already rely on.
    expect(html.split('truncate').length - 1).toBe(2)
    expect(html).not.toContain('break-words')
  })

  it('wrapTitle/wrapMeta opt out of truncation so a route or a rate line is never silently deleted', () => {
    const html = renderToStaticMarkup(
      <FinancialListRow
        title="Cash → USD Savings"
        meta="21:20 08/09/2026 · 1 USD = 25.000 VND"
        amount={<span>1</span>}
        wrapTitle
        wrapMeta
      />,
    )
    expect(html).not.toContain('truncate')
    expect(html.split('break-words').length - 1).toBe(2)
    expect(html).toContain('Cash → USD Savings')
    expect(html).toContain('1 USD = 25.000 VND')
  })
})
