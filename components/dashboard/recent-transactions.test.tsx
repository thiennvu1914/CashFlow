import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import type { RecentTransactionDto } from '@/lib/ui/dashboard-view-model'

/**
 * `RecentTransactions` is an async server component calling `getTranslations`
 * (`next-intl/server`), which needs a real Next.js request scope (it resolves
 * the locale via `next/headers`) — unavailable in a plain Vitest run. Mocked
 * here with `createTranslator` (`next-intl`'s core, request-scope-free helper)
 * fed the REAL `vi` message tree, so the assertions below are against the
 * actual copy the app renders, not a stand-in string.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async () =>
    createTranslator({ locale: 'vi', messages: await loadMessages('vi') }),
}))

const { RecentTransactions } = await import('./recent-transactions')

function row(overrides: Partial<RecentTransactionDto> & { id: string }): RecentTransactionDto {
  return {
    categoryName: 'Food',
    type: 'EXPENSE',
    accountName: 'Wallet',
    date: new Date('2026-09-14T02:15:00Z'),
    amount: '−250.000',
    currency: 'VND',
    positive: false,
    ...overrides,
  }
}

describe('RecentTransactions', () => {
  it("shows the TYPE's translated label, never the raw enum, when there is no category", async () => {
    const element = await RecentTransactions({
      transactions: [row({ id: 't1', categoryName: null, type: 'CASH_OUT' })],
      locale: 'vi',
      timeZone: 'Asia/Ho_Chi_Minh',
    })
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Tiền ra (khác)')
    expect(html).not.toContain('CASH_OUT')
  })

  it('hides rows at or past `mobileLimit` below xl, so the mobile stack shows fewer rows from one fetch', async () => {
    const transactions = Array.from({ length: 8 }, (_, index) => row({ id: `t${index}` }))
    const element = await RecentTransactions({
      transactions,
      locale: 'vi',
      timeZone: 'Asia/Ho_Chi_Minh',
      mobileLimit: 5,
    })
    const html = renderToStaticMarkup(element)

    const items = html.split('<li').slice(1)
    expect(items).toHaveLength(8)
    items.slice(0, 5).forEach((item) => expect(item).not.toContain('hidden xl:flex'))
    items.slice(5).forEach((item) => expect(item).toContain('hidden xl:flex'))
  })
})
