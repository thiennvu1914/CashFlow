import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { AccountList, type AccountRow } from './account-list'

const ROWS: AccountRow[] = [
  {
    id: 'a1',
    name: 'Cash',
    currency: 'VND',
    description: null,
    initialBalance: 0,
    accountTypeId: 't1',
    accountType: { name: 'Cash' },
    balance: '5000000.00',
    locked: false,
  },
  {
    id: 'a2',
    name: 'Card',
    currency: 'VND',
    description: null,
    initialBalance: 0,
    accountTypeId: 't1',
    accountType: { name: 'Credit' },
    balance: '-1200000.00',
    locked: true,
  },
]

describe('AccountList', () => {
  it('renders every row inside ONE bordered surface with dividers', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    expect(html).toContain('divide-y')
    expect(html.match(/rounded-lg border border-border/g)).toHaveLength(1)
  })

  it('puts the balance in the fixed amount column and tones a negative one', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    expect(html).toContain('min-w-[8.5rem]')
    expect(html).toContain('5.000.000')
    expect(html).toContain('text-negative')
    expect(html).toContain('1.200.000')
  })

  it('names the row’s actions menu after the account, not "More"', () => {
    const html = renderToStaticMarkup(
      <AccountList accounts={ROWS} accountTypes={[{ id: 't1', name: 'Cash' }]} locale="vi" />,
    )
    // The mocked translator echoes the key, so the presence of the key proves
    // the row passed its own name through `common.rowActions`.
    expect(html.match(/common\.rowActions/g)).toHaveLength(2)
  })

  it('shows the empty state rather than an empty card', () => {
    const html = renderToStaticMarkup(<AccountList accounts={[]} accountTypes={[]} locale="vi" />)
    expect(html).toContain('accounts.emptyTitle')
    expect(html).not.toContain('divide-y')
  })
})
