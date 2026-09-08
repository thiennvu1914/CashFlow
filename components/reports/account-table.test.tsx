import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { AccountTable } from './account-table'

const LABELS = {
  account: 'Tài khoản',
  income: 'Thu nhập',
  expense: 'Chi tiêu',
  netIncome: 'Thu nhập ròng',
}

const ROWS = [
  {
    id: 'a1',
    name: 'Vietcombank',
    income: '500.000',
    expense: '200.000',
    netIncome: '300.000',
    netNegative: false,
  },
  {
    id: 'a2',
    name: 'USD Wallet',
    income: '0,00',
    expense: '150,00',
    netIncome: '−150,00',
    netNegative: true,
  },
]

describe('AccountTable', () => {
  it('renders both a desktop table (hidden md:table) and a mobile stacked list (md:hidden)', () => {
    const html = renderToStaticMarkup(<AccountTable rows={ROWS} currency="VND" labels={LABELS} />)
    expect(html).toContain('<table')
    expect(html.match(/<table[^>]*class="[^"]*\bhidden\b[^"]*\bmd:table\b[^"]*"/)).toBeTruthy()
    expect(html.match(/<ul[^>]*class="[^"]*\bmd:hidden\b[^"]*"/)).toBeTruthy()
  })

  it('marks a negative net income with text-negative in BOTH renderings', () => {
    const html = renderToStaticMarkup(<AccountTable rows={ROWS} currency="VND" labels={LABELS} />)
    expect(html.match(/text-negative/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('uses <th scope="col"> four times and <th scope="row"> once per row', () => {
    const html = renderToStaticMarkup(<AccountTable rows={ROWS} currency="VND" labels={LABELS} />)
    expect(html.match(/<th scope="col"/g)).toHaveLength(4)
    expect(html.match(/<th scope="row"/g)).toHaveLength(ROWS.length)
  })
})
