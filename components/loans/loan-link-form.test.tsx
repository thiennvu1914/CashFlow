import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viDebts from '@/messages/vi/debts.json'
import viLoans from '@/messages/vi/loans.json'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { RowErrorProvider } from '@/components/common/row-error-context'

/**
 * Markup tests for "Record in an account" on a loan (spec 2026-10-12 §6.4), in
 * the style of `loan-payment-form.test.tsx`: `renderToStaticMarkup`, with the
 * router and the action module (which pulls in Prisma) mocked.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/loan-actions', () => ({
  recordLoanPaymentAction: vi.fn(),
  updateLoanPaymentAction: vi.fn(),
  deleteLoanPaymentAction: vi.fn(),
  closeLoanAction: vi.fn(),
  linkLoanToAccountAction: vi.fn(),
}))

const { LoanLinkForm } = await import('./loan-link-form')
const { LoanRowMenu } = await import('./loan-row-actions')

const messages = await loadMessages('vi')

const ACCOUNTS = [
  { id: 'acc_wallet', name: 'Ví tiền mặt', currency: 'VND' as const },
  { id: 'acc_bank', name: 'Ngân hàng', currency: 'VND' as const },
  { id: 'acc_usd', name: 'Savings USD', currency: 'USD' as const },
]

const PAYMENT: LoanDto['payments'][number] = {
  id: 'pay_1',
  date: '2026-10-05',
  total: '900.000',
  principal: '800.000',
  interest: '100.000',
  totalInput: '900000.00',
  interestInput: '100000.00',
  note: null,
  accountId: null,
  accountName: null,
  accountArchived: false,
}

function loan(overrides: Partial<LoanDto> = {}): LoanDto {
  return {
    id: 'loan_1',
    lender: 'Bank',
    currency: 'VND',
    principal: '10.000.000',
    principalPaid: '0',
    interestPaid: '0',
    outstandingPrincipal: '10.000.000',
    percentRepaid: 0,
    percentLabel: '0 %',
    nextDueDate: '2026-11-12',
    dueSoon: false,
    overdue: false,
    scheduledPayment: '900.000',
    scheduledPaymentInput: '900000.00',
    disbursementAccountId: null,
    paymentFrequency: 'MONTHLY',
    interestRateLabel: '8,5 %',
    termMonths: 12,
    startDate: '2026-01-15',
    status: 'ACTIVE',
    active: true,
    notes: null,
    payments: [],
    editable: { lender: 'Bank', scheduledPaymentAmount: '900000.00', notes: '' },
    ...overrides,
  }
}

function render(
  props: { loan?: LoanDto; mostRecentAccountId?: string | null; accounts?: typeof ACCOUNTS } = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <LoanLinkForm
        loan={props.loan ?? loan()}
        accounts={props.accounts ?? ACCOUNTS}
        mostRecentAccountId={
          props.mostRecentAccountId === undefined ? null : props.mostRecentAccountId
        }
        onDone={() => {}}
      />
    </NextIntlClientProvider>,
  )
}

function accountSelect(html: string): string {
  const start = html.lastIndexOf('<select', html.indexOf('id="loan-link-account-'))
  return html.slice(start, html.indexOf('</select>', start) + '</select>'.length)
}

function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('LoanLinkForm ("Record in an account")', () => {
  it("lists only the accounts in the loan's currency, under the create form's label, with no 'don't record' choice", () => {
    const html = render()
    const select = accountSelect(html)

    expect(html).toContain(viLoans.account)
    expect(select).toContain('Ví tiền mặt · VND')
    expect(select).toContain('Ngân hàng · VND')
    expect(select).not.toContain('Savings USD')
    expect(select).not.toContain(viDebts.accountNone)
  })

  it('starts on the most recently used account, else on the first listed one', () => {
    expect(accountSelect(render({ mostRecentAccountId: 'acc_bank' }))).toMatch(
      selectedOption('acc_bank'),
    )
    expect(accountSelect(render({ mostRecentAccountId: null }))).toMatch(
      selectedOption('acc_wallet'),
    )
  })

  it("dates the disbursement on the loan's start date", () => {
    const html = render()

    expect(html).toContain(viLoans.linkDisbursedOn)
    expect(html).toMatch(/type="date"[^>]*value="2026-01-15"|value="2026-01-15"[^>]*type="date"/)
  })

  it('offers to record the instalments that have no transaction yet, checked by default', () => {
    const linked = { ...PAYMENT, id: 'pay_linked', accountId: 'acc_bank', accountName: 'Ngân hàng' }
    const html = render({ loan: loan({ payments: [PAYMENT, linked] }) })

    expect(html).toContain('Ghi bù 1 lần trả đã có')
    expect(html).toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
  })

  it('asks nothing about instalments when none is left to record', () => {
    const html = render()

    expect(html).not.toContain('Ghi bù')
    expect(html).not.toContain('type="checkbox"')
  })

  it("says so, and offers no picker, when no account holds the loan's currency", () => {
    const html = render({ loan: loan({ currency: 'USD' }), accounts: ACCOUNTS.slice(0, 2) })

    expect(html).toContain('Chưa có tài khoản USD nào đang hoạt động')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('type="submit"')
  })
})

describe('LoanRowMenu', () => {
  function renderMenu(dto: LoanDto): string {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
        <RowErrorProvider>
          <LoanRowMenu loan={dto} accounts={ACCOUNTS} mostRecentAccountId={null} />
        </RowErrorProvider>
      </NextIntlClientProvider>,
    )
  }

  it('stays on a closed loan that moved no money, so it can still be recorded in an account', () => {
    expect(renderMenu(loan({ active: false, status: 'CLOSED' }))).toContain('Tác vụ cho Bank')
  })

  it('offers nothing on a closed loan that is already recorded in an account', () => {
    expect(
      renderMenu(loan({ active: false, status: 'CLOSED', disbursementAccountId: 'acc_bank' })),
    ).toBe('')
  })
})
