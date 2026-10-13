import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viDebts from '@/messages/vi/debts.json'
import type { DebtDto } from '@/lib/ui/debt-view-model'
import { RowErrorProvider } from '@/components/common/row-error-context'

/**
 * Markup tests for the payment form's account picker, in the style of
 * `debt-form.test.tsx`: `renderToStaticMarkup`, with the router and the action
 * module (which pulls in Prisma) mocked.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/debt-actions', () => ({
  recordDebtPaymentAction: vi.fn(),
  updateDebtPaymentAction: vi.fn(),
  deleteDebtPaymentAction: vi.fn(),
  updateDebtAction: vi.fn(),
  writeOffDebtAction: vi.fn(),
  linkDebtToAccountAction: vi.fn(),
  unlinkDebtFromAccountAction: vi.fn(),
}))

const { DebtPaymentForm, DebtRowMenu } = await import('./debt-row-actions')

const messages = await loadMessages('vi')

const ACCOUNTS = [
  { id: 'acc_wallet', name: 'Ví tiền mặt', currency: 'VND' as const },
  { id: 'acc_bank', name: 'Ngân hàng', currency: 'VND' as const },
  { id: 'acc_usd', name: 'Savings USD', currency: 'USD' as const },
]

const PAYMENT = {
  id: 'pay_1',
  date: '2026-10-05',
  amount: '250.000',
  amountInput: '250000.00',
  note: 'Đợt một',
  accountId: 'acc_bank',
  accountName: 'Ngân hàng',
  accountArchived: false,
}

function debt(overrides: Partial<DebtDto> = {}): DebtDto {
  return {
    id: 'debt_1',
    person: 'Minh',
    direction: 'RECEIVABLE',
    currency: 'VND',
    original: '1.000.000',
    paid: '0',
    outstanding: '1.000.000',
    percentPaid: 0,
    percentLabel: '0 %',
    status: 'OPEN',
    active: true,
    dueDate: null,
    description: null,
    notes: null,
    openingAccountId: null,
    createdOn: '2026-09-20',
    payments: [PAYMENT],
    editable: { person: 'Minh', description: '', dueDate: '', notes: '' },
    ...overrides,
  }
}

function render(
  props: {
    debt?: DebtDto
    mostRecentAccountId?: string | null
    payment?: DebtDto['payments'][number]
  } = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <DebtPaymentForm
        debt={props.debt ?? debt()}
        today="2026-10-12"
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

/** The one `<select>` for the account — `<select>`s cannot nest. */
function accountSelect(html: string): string {
  const start = html.lastIndexOf('<select', html.indexOf('id="debt-payment-account-'))
  return html.slice(start, html.indexOf('</select>', start) + '</select>'.length)
}

function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('DebtPaymentForm account picker', () => {
  it("lists 'don't record' first, then only the accounts in the debt's currency", () => {
    const select = accountSelect(render())

    expect(select.indexOf(viDebts.accountNone)).toBeGreaterThan(-1)
    expect(select.indexOf(viDebts.accountNone)).toBeLessThan(select.indexOf('Ví tiền mặt'))
    expect(select).toContain('Ví tiền mặt · VND')
    expect(select).toContain('Ngân hàng · VND')
    expect(select).not.toContain('Savings USD')
  })

  it("pre-selects the debt's opening account over the most recently used one", () => {
    const select = accountSelect(
      render({ debt: debt({ openingAccountId: 'acc_bank' }), mostRecentAccountId: 'acc_wallet' }),
    )
    expect(select).toMatch(selectedOption('acc_bank'))
    expect(select).not.toMatch(selectedOption('acc_wallet'))
  })

  it('falls back to the most recently used account when the debt moved no money', () => {
    expect(accountSelect(render({ mostRecentAccountId: 'acc_wallet' }))).toMatch(
      selectedOption('acc_wallet'),
    )
  })

  it("starts on 'don't record' when the most recent account is in another currency", () => {
    const select = accountSelect(render({ mostRecentAccountId: 'acc_usd' }))
    expect(select).toMatch(selectedOption(''))
  })

  it('shows what is still owed for a new payment', () => {
    expect(render()).toContain('Còn lại 1.000.000 VND')
  })
})

describe('DebtPaymentForm correcting a recorded payment', () => {
  it("starts on the payment's own account, whatever the debt's other accounts are", () => {
    // The opening account and the most recent one differ from the payment's, so
    // only the payment itself can explain the selection.
    const html = render({
      payment: PAYMENT,
      debt: debt({ openingAccountId: 'acc_wallet' }),
      mostRecentAccountId: 'acc_wallet',
    })

    expect(accountSelect(html)).toMatch(selectedOption('acc_bank'))
    expect(html).toContain(viDebts.paymentEditLinkedNote)
    // The outstanding line belongs to recording a new payment.
    expect(html).not.toContain('Còn lại')
  })

  it('keeps an unlinked payment unlinked rather than pre-selecting the most recent account', () => {
    const html = render({
      payment: { ...PAYMENT, accountId: null },
      mostRecentAccountId: 'acc_wallet',
    })
    expect(accountSelect(html)).toMatch(selectedOption(''))
    expect(html).not.toContain(viDebts.paymentEditLinkedNote)
  })

  it("keeps the payment's account selected, labelled archived, when it has been archived since", () => {
    const html = render({
      payment: {
        ...PAYMENT,
        accountId: 'acc_old',
        accountName: 'Ví cũ',
        accountArchived: true,
      },
      mostRecentAccountId: 'acc_wallet',
    })
    const select = accountSelect(html)

    expect(select).toContain('Ví cũ · VND (đã lưu trữ)')
    expect(select).toMatch(selectedOption('acc_old'))
    // Not "don't record": saving that would unlink the payment and delete its
    // transaction.
    expect(select).not.toMatch(selectedOption(''))
  })
})

describe('DebtRowMenu', () => {
  function renderMenu(dto: DebtDto): string {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
        <RowErrorProvider>
          <DebtRowMenu debt={dto} accounts={ACCOUNTS} mostRecentAccountId={null} />
        </RowErrorProvider>
      </NextIntlClientProvider>,
    )
  }

  it('stays on a written-off debt that moved no money, so it can still be recorded in an account', () => {
    expect(renderMenu(debt({ active: false, status: 'WRITTEN_OFF' }))).toContain('Tác vụ cho Minh')
  })

  it('stays on a written-off debt that is recorded in an account, so a wrong account can still be undone', () => {
    // Its one item is "Remove from account" (`agreementMenuActions`); a closed
    // menu renders only its trigger here.
    expect(
      renderMenu(debt({ active: false, status: 'WRITTEN_OFF', openingAccountId: 'acc_bank' })),
    ).toContain('Tác vụ cho Minh')
  })
})
