import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viLoans from '@/messages/vi/loans.json'
import viDebts from '@/messages/vi/debts.json'
import type { LoanDto } from '@/lib/ui/loan-view-model'

/**
 * Markup tests for the instalment dialog, in the style of
 * `debt-row-actions.test.tsx`: `renderToStaticMarkup`, with the router and the
 * action module (which pulls in Prisma) mocked. `useWatch` returns the form's
 * defaults on the server, so the pre-filled total and the principal derived
 * from it are visible in the markup; typed values are the e2e's to cover.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/loan-actions', () => ({
  recordLoanPaymentAction: vi.fn(),
  updateLoanPaymentAction: vi.fn(),
  deleteLoanPaymentAction: vi.fn(),
  closeLoanAction: vi.fn(),
}))

const { LoanPaymentForm } = await import('./loan-payment-form')

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
  note: 'Kỳ một',
  accountId: 'acc_bank',
  accountName: 'Ngân hàng',
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
    startDate: '2026-10-12',
    status: 'ACTIVE',
    active: true,
    notes: null,
    payments: [PAYMENT],
    editable: { lender: 'Bank', scheduledPaymentAmount: '900000.00', notes: '' },
    ...overrides,
  }
}

function render(
  props: {
    loan?: LoanDto
    mostRecentAccountId?: string | null
    payment?: LoanDto['payments'][number]
  } = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <LoanPaymentForm
        loan={props.loan ?? loan()}
        today="2026-10-12"
        locale="vi"
        accounts={ACCOUNTS}
        mostRecentAccountId={
          props.mostRecentAccountId === undefined ? null : props.mostRecentAccountId
        }
        payment={props.payment}
        onDone={() => {}}
      />
    </NextIntlClientProvider>,
  )
}

/** The markup of the account `<select>` — `<select>`s cannot nest. */
function accountSelect(html: string): string {
  const start = html.lastIndexOf('<select', html.indexOf('id="loan-payment-account-'))
  return html.slice(start, html.indexOf('</select>', start) + '</select>'.length)
}

/** The opening tag of the one `<input>` whose id starts with `prefix`. */
function inputMarkup(html: string, prefix: string): string {
  const at = html.indexOf(`id="${prefix}-`)
  const start = html.lastIndexOf('<input', at)
  return html.slice(start, html.indexOf('>', at) + 1)
}

function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('LoanPaymentForm amounts', () => {
  it('pre-fills the total with the scheduled instalment and the interest with 0', () => {
    const html = render()

    expect(inputMarkup(html, 'loan-payment-total')).toContain('value="900000"')
    expect(inputMarkup(html, 'loan-payment-interest')).toContain('value="0"')
  })

  it("starts a correction on the instalment's own interest, not 0", () => {
    const html = render({ payment: PAYMENT })

    expect(inputMarkup(html, 'loan-payment-interest')).toContain('value="100000.00"')
  })

  it('shows the principal as the total minus the interest, read-only, starting as the whole total', () => {
    const html = render()
    const principal = inputMarkup(html, 'loan-payment-principal')

    expect(principal).toMatch(/readOnly=""|readonly=""/)
    expect(principal).toContain('value="900.000 VND"')
    expect(html).toContain(viLoans.paymentPrincipalNote)
  })

  it('lists the fields as total, interest, principal', () => {
    const html = render()
    const at = (id: string) => html.indexOf(`id="loan-payment-${id}-`)

    expect(at('total')).toBeLessThan(at('interest'))
    expect(at('interest')).toBeLessThan(at('principal'))
  })

  it('shows the principal still outstanding for a new instalment only', () => {
    expect(render()).toContain('Dư nợ gốc còn lại 10.000.000 VND')
    expect(render({ payment: PAYMENT })).not.toContain('Dư nợ gốc còn lại')
  })

  it('starts a correction on the recorded principal split: principal is total minus interest', () => {
    const principal = inputMarkup(render({ payment: PAYMENT }), 'loan-payment-principal')

    expect(principal).toContain('value="800.000 VND"')
  })
})

describe('LoanPaymentForm account picker', () => {
  it("lists 'don't record' first, then only the accounts in the loan's currency", () => {
    const select = accountSelect(render())

    expect(select.indexOf(viDebts.accountNone)).toBeGreaterThan(-1)
    expect(select.indexOf(viDebts.accountNone)).toBeLessThan(select.indexOf('Ví tiền mặt'))
    expect(select).toContain('Ví tiền mặt · VND')
    expect(select).toContain('Ngân hàng · VND')
    expect(select).not.toContain('Savings USD')
  })

  it('pre-selects the account the loan was received into over the most recently used one', () => {
    const select = accountSelect(
      render({
        loan: loan({ disbursementAccountId: 'acc_bank' }),
        mostRecentAccountId: 'acc_wallet',
      }),
    )

    expect(select).toMatch(selectedOption('acc_bank'))
    expect(select).not.toMatch(selectedOption('acc_wallet'))
  })

  it('falls back to the most recently used account when the loan moved no money', () => {
    expect(accountSelect(render({ mostRecentAccountId: 'acc_wallet' }))).toMatch(
      selectedOption('acc_wallet'),
    )
  })

  it("starts on 'don't record' when the most recent account is in another currency", () => {
    expect(accountSelect(render({ mostRecentAccountId: 'acc_usd' }))).toMatch(selectedOption(''))
  })
})

describe('LoanPaymentForm correcting a recorded instalment', () => {
  it("starts on the instalment's own account, whatever the loan's other accounts are", () => {
    const html = render({
      payment: PAYMENT,
      loan: loan({ disbursementAccountId: 'acc_wallet' }),
      mostRecentAccountId: 'acc_wallet',
    })

    expect(accountSelect(html)).toMatch(selectedOption('acc_bank'))
    expect(html).toContain(viLoans.paymentEditLinkedNote)
  })

  it('keeps an unlinked instalment unlinked rather than pre-selecting the most recent account', () => {
    const html = render({
      payment: { ...PAYMENT, accountId: null },
      mostRecentAccountId: 'acc_wallet',
    })

    expect(accountSelect(html)).toMatch(selectedOption(''))
    expect(html).not.toContain(viLoans.paymentEditLinkedNote)
  })

  it("keeps the instalment's account selected, labelled archived, when it has been archived since", () => {
    const select = accountSelect(
      render({
        payment: { ...PAYMENT, accountId: 'acc_old', accountName: 'Ví cũ', accountArchived: true },
        mostRecentAccountId: 'acc_wallet',
      }),
    )

    expect(select).toContain('Ví cũ · VND (đã lưu trữ)')
    expect(select).toMatch(selectedOption('acc_old'))
    expect(select).not.toMatch(selectedOption(''))
  })
})
