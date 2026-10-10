import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'

/**
 * A markup test, not a DOM test (this repo has no jsdom or Testing Library —
 * see `transaction-form.test.tsx`). It pins what the list shows on first paint
 * and that the dialog's state no longer lives in the list. The press-delete
 * behaviour (row vanishes at once, returns with the error when the action
 * fails) needs a real browser and is covered by
 * `e2e/phase7-confirm-dialogs.spec.ts` and `e2e/phase7-transactions.spec.ts`.
 *
 * The server action module is mocked: importing the real one pulls in Prisma
 * and Better Auth for a test that never submits.
 */
vi.mock('@/lib/server/actions/transaction-actions', () => ({
  deleteTransactionAction: vi.fn(),
}))

const { TransactionList } = await import('./transaction-list')
const messages = await loadMessages('vi')

const TZ = 'Asia/Ho_Chi_Minh'

function row(id: string, note: string | null, categoryName: string | null) {
  return {
    id,
    type: 'CASH_OUT' as const,
    amount: '125000.00',
    currency: 'VND' as const,
    date: new Date('2026-09-08T17:30:00.000Z'),
    note,
    fxRateSource: 'primary',
    account: { name: 'Cash' },
    category: categoryName ? { name: categoryName } : null,
  }
}

function render(transactions: ReturnType<typeof row>[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone={TZ} messages={messages}>
      <TransactionList
        transactions={transactions}
        timezone={TZ}
        locale="vi"
        today="2026-09-09"
        yesterday="2026-09-08"
      />
    </NextIntlClientProvider>,
  )
}

describe('TransactionList', () => {
  it('renders one row per transaction with its time, account and an actions menu', () => {
    const html = render([row('a', 'lunch', 'Food & Dining'), row('b', null, null)])
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html).toContain('Food &amp; Dining')
    expect(html).toContain('00:30')
    expect(html).toContain('Cash')
    expect(html).toContain('lunch')
    expect(html.match(/aria-label="[^"]*"/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('shows the empty state and no ledger when there are no rows', () => {
    const html = render([])
    expect(html).toContain('Chưa có giao dịch')
    expect(html).not.toContain('<li ')
  })

  it('does not render the confirmation until a delete is requested', () => {
    expect(render([row('a', null, 'Food & Dining')])).not.toContain('role="dialog"')
  })
})
