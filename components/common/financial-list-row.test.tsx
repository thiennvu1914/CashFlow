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
})
