import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import { DEBT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import viDebts from '@/messages/vi/debts.json'
import enDebts from '@/messages/en/debts.json'
import type { DebtDto } from '@/lib/ui/debt-view-model'

/**
 * Markup tests for "Record in an account" on a debt (spec 2026-10-12 §6.4), in
 * the style of `debt-row-actions.test.tsx`: `renderToStaticMarkup`, with the
 * router and the action module (which pulls in Prisma) mocked.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/debt-actions', () => ({
  linkDebtToAccountAction: vi.fn(),
}))

const { DebtLinkForm } = await import('./debt-link-form')
const { linkFormErrorKeys } = await import('./link-to-account-form')

const messages = await loadMessages('vi')

/** The user's calendar day, as the page passes it (profile zone). */
const TODAY = '2026-10-12'

const ACCOUNTS = [
  { id: 'acc_wallet', name: 'Ví tiền mặt', currency: 'VND' as const },
  { id: 'acc_bank', name: 'Ngân hàng', currency: 'VND' as const },
  { id: 'acc_usd', name: 'Savings USD', currency: 'USD' as const },
]

const LINKED_PAYMENT: DebtDto['payments'][number] = {
  id: 'pay_1',
  date: '2026-10-05',
  amount: '250.000',
  amountInput: '250000.00',
  note: null,
  accountId: 'acc_bank',
  accountName: 'Ngân hàng',
  accountArchived: false,
}

const UNLINKED_PAYMENT = { ...LINKED_PAYMENT, id: 'pay_2', accountId: null, accountName: null }

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
    payments: [],
    editable: { person: 'Minh', description: '', dueDate: '', notes: '' },
    ...overrides,
  }
}

function render(
  props: { debt?: DebtDto; mostRecentAccountId?: string | null; accounts?: typeof ACCOUNTS } = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <DebtLinkForm
        debt={props.debt ?? debt()}
        today={TODAY}
        accounts={props.accounts ?? ACCOUNTS}
        mostRecentAccountId={
          props.mostRecentAccountId === undefined ? null : props.mostRecentAccountId
        }
        onDone={() => {}}
      />
    </NextIntlClientProvider>,
  )
}

/** The one `<select>` for the account — `<select>`s cannot nest. */
function accountSelect(html: string): string {
  const start = html.lastIndexOf('<select', html.indexOf('id="debt-link-account-'))
  return html.slice(start, html.indexOf('</select>', start) + '</select>'.length)
}

function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

function dateValue(value: string): RegExp {
  return new RegExp(`type="date"[^>]*value="${value}"|value="${value}"[^>]*type="date"`)
}

describe('DebtLinkForm ("Record in an account")', () => {
  it("lists only the accounts in the debt's currency, with no 'don't record' choice", () => {
    const select = accountSelect(render())

    expect(select).toContain('Ví tiền mặt · VND')
    expect(select).toContain('Ngân hàng · VND')
    expect(select).not.toContain('Savings USD')
    // Recording in an account is the whole point of this dialog.
    expect(select).not.toContain(viDebts.accountNone)
    expect(select).not.toMatch(selectedOption(''))
  })

  it('starts on the most recently used account, else on the first listed one', () => {
    expect(accountSelect(render({ mostRecentAccountId: 'acc_bank' }))).toMatch(
      selectedOption('acc_bank'),
    )
    expect(accountSelect(render({ mostRecentAccountId: 'acc_usd' }))).toMatch(
      selectedOption('acc_wallet'),
    )
  })

  it('dates the opening on the day the debt was added when nothing to record is older', () => {
    const html = render({
      debt: debt({ payments: [{ ...UNLINKED_PAYMENT, date: '2026-10-01' }] }),
    })

    expect(html).toContain(viDebts.linkDate)
    expect(html).toMatch(dateValue('2026-09-20'))
  })

  it('dates the opening on the oldest payment still to record when that is earlier (Ruling P7)', () => {
    // Added to the app on 20 September, repaid from 2 September — and an older
    // payment already in an account does not count, the link leaves it alone.
    const html = render({
      debt: debt({
        payments: [
          { ...LINKED_PAYMENT, date: '2026-08-15' },
          { ...UNLINKED_PAYMENT, date: '2026-09-02' },
          { ...UNLINKED_PAYMENT, id: 'pay_3', date: '2026-09-25' },
        ],
      }),
    })

    expect(html).toMatch(dateValue('2026-09-02'))
  })

  it('offers to record the payments that have no transaction yet, checked by default', () => {
    // One payment already moved money through an account; only the other two count.
    const html = render({
      debt: debt({
        payments: [LINKED_PAYMENT, UNLINKED_PAYMENT, { ...UNLINKED_PAYMENT, id: 'pay_3' }],
      }),
    })

    expect(html).toContain('Ghi bù 2 lần trả đã có')
    expect(html).toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
  })

  it('warns beside the box that payments entered by hand on the Transactions page are not detected — delete them or untick it', () => {
    const html = render({ debt: debt({ payments: [UNLINKED_PAYMENT] }) })

    expect(html).toContain('Lần trả bạn đã tự nhập ở trang Giao dịch không được nhận ra')
    expect(html).toContain('hãy xóa các giao dịch đó trước, hoặc bỏ chọn ô này')
    // The box stays ticked by default all the same.
    expect(html).toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
  })

  it("says in the dialog's description, in both languages, that a hand-entered opening is not detected either", () => {
    expect(viDebts.linkDescription).toContain(
      'Giao dịch bạn đã tự nhập ở trang Giao dịch không được nhận ra',
    )
    expect(viDebts.linkDescription).toContain('hãy xóa giao dịch đó trước')
    expect(enDebts.linkDescription).toContain(
      'Transactions you entered yourself on the Transactions page are not detected',
    )
    expect(enDebts.linkIncludePaymentsHelper).toContain('untick this box')
  })

  it('asks nothing about payments when none is left to record', () => {
    const html = render({ debt: debt({ payments: [LINKED_PAYMENT] }) })

    expect(html).not.toContain('Ghi bù')
    expect(html).not.toContain('type="checkbox"')
  })

  it("says so, and offers no picker, when no account holds the debt's currency", () => {
    const html = render({ debt: debt({ currency: 'USD' }), accounts: ACCOUNTS.slice(0, 2) })

    expect(html).toContain('Chưa có tài khoản USD nào đang hoạt động')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('type="submit"')
  })
})

describe('linkFormErrorKeys for a debt', () => {
  it('answers ARCHIVED_ACCOUNT with the dialog\'s own copy — it offers no "don\'t record" to fall back on', () => {
    const keys = linkFormErrorKeys('debts', DEBT_ERROR_KEYS)

    expect(keys.ARCHIVED_ACCOUNT).toBe('debts.linkArchivedAccount')
    expect(viDebts.linkArchivedAccount).toBe(
      'Tài khoản này vừa được lưu trữ — hãy tải lại trang và chọn một tài khoản đang hoạt động.',
    )
    expect(enDebts.linkArchivedAccount).toBe(
      'That account has just been archived. Reload the page and choose an active account.',
    )
    expect(viDebts.linkArchivedAccount).not.toContain(viDebts.accountNone)
  })

  it('keeps every other code on its usual message', () => {
    const keys = linkFormErrorKeys('debts', DEBT_ERROR_KEYS)

    // Put the one override back, and nothing else may differ.
    expect({ ...keys, ARCHIVED_ACCOUNT: DEBT_ERROR_KEYS.ARCHIVED_ACCOUNT }).toEqual(DEBT_ERROR_KEYS)
  })
})
