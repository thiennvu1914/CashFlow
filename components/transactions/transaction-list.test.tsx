import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import type { TransactionLink } from '@/lib/server/services/transaction-links'

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
  createTransactionAction: vi.fn(),
  updateTransactionAction: vi.fn(),
  deleteTransactionAction: vi.fn(),
}))

// "Open debt/loan" navigates and `?edit=<id>` is read from the URL; both hooks
// throw outside a mounted Next app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const { TransactionList } = await import('./transaction-list')
const messages = await loadMessages('vi')

const TZ = 'Asia/Ho_Chi_Minh'

function row(
  id: string,
  note: string | null,
  categoryName: string | null,
  link: TransactionLink | null = null,
) {
  return {
    id,
    type: 'CASH_OUT' as const,
    amount: '125000.00',
    currency: 'VND' as const,
    date: new Date('2026-09-08T17:30:00.000Z'),
    note,
    fxRateSource: 'primary',
    accountId: 'acc_cash',
    categoryId: categoryName ? `cat_${id}` : null,
    account: { name: 'Cash' },
    category: categoryName ? { name: categoryName } : null,
    link,
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

  it('does not render the edit sheet until an edit is requested', () => {
    const html = render([row('a', null, 'Food & Dining')])
    expect(html).not.toContain('Sửa giao dịch')
    expect(html).not.toContain('<form')
  })

  /**
   * Money-source linking (spec 2026-10-12 §2 Q4, §6.5): a row a debt or loan
   * owns names it, so the user can tell before opening the menu why it offers
   * only "open the debt/loan". What the menu offers is pinned in
   * `transaction-row-actions.test.ts`.
   */
  it('badges a row a debt owns with the person, and one a loan owns with the lender', () => {
    const html = render([
      row('a', null, null, { kind: 'debt', debtId: 'debt_1', person: 'Minh' }),
      row('b', null, 'Loan Interest & Fees', {
        kind: 'loan',
        loanId: 'loan_1',
        lender: 'Vietcombank',
      }),
    ])

    expect(html).toContain('Nợ: Minh')
    expect(html).toContain('Vay: Vietcombank')
  })

  it('puts no badge on an ordinary row', () => {
    const html = render([row('a', 'lunch', 'Food & Dining')])
    expect(html).not.toMatch(/Nợ: |Vay: /)
  })
})
