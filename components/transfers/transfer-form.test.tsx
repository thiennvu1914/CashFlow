import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import type { Currency } from '@prisma/client'
import { loadMessages } from '@/lib/i18n/messages'

/**
 * A markup test, exactly like `components/transactions/transaction-form.test.tsx`
 * — `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and the one `<select>` whose
 * form default is not its first option — plus, new in Task 5b, that every
 * field carries a visible `<label>` rather than an `aria-label`-only control.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the transactions test.
 * Rendered inside a real `NextIntlClientProvider` fed the actual `vi` message
 * tree, so every string asserted below is the actual product copy.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/transfer-actions', () => ({
  createTransferAction: vi.fn(),
}))

const { TransferForm } = await import('./transfer-form')

type Account = { id: string; name: string; currency: Currency }

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const CASH: Account = { id: 'acc_cash', name: 'Cash', currency: 'VND' }
const WALLET: Account = { id: 'acc_wallet', name: 'Wallet', currency: 'VND' }
const USD_SAVINGS: Account = { id: 'acc_usd', name: 'USD Savings', currency: 'USD' }

const messages = await loadMessages('vi')

function render(accounts: Account[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone={TIMEZONE} messages={messages}>
      <TransferForm accounts={accounts} timezone={TIMEZONE} locale="vi" />
    </NextIntlClientProvider>,
  )
}

/** The markup of one `<select>`, found by a field name — same convention as
 *  `TransactionForm`'s test: every field's `id` is `transfer-<name>-<useId()
 *  suffix>`, unique per mounted instance, so this matches the PREFIX rather
 *  than an exact id. Scoping matters here more than anywhere: both account
 *  selectors render the SAME option values, and only one of them may carry a
 *  pre-selected option. */
function selectMarkup(html: string, name: string): string {
  const idMatch = html.match(new RegExp(`id="transfer-${name}-[^"]*"`))
  if (!idMatch) throw new Error(`No element with a transfer-${name}-* id in the markup`)
  const idIndex = html.indexOf(idMatch[0])
  const start = html.lastIndexOf('<select', idIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select id="transfer-${name}-*">`)
  return html.slice(start, end + '</select>'.length)
}

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('TransferForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render([CASH, WALLET])

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">Chuyển tiền</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `TransactionForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-4"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders the To account default — the SECOND account — as selected', () => {
    const toSelect = selectMarkup(render([CASH, WALLET]), 'to')

    // A transfer defaults to moving money *between* accounts, so `toAccountId`
    // is `accounts[1]` — not the first option. Without `defaultValue` the
    // browser would show "Cash" while form state already said "Wallet".
    expect(toSelect).toMatch(selectedOption(WALLET.id))
    expect(toSelect).not.toMatch(selectedOption(CASH.id))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(toSelect).not.toMatch(/<select[^>]*\svalue=/)
  })

  it('leaves the From account select with no pre-selected option — its default IS the first', () => {
    const fromSelect = selectMarkup(render([CASH, WALLET]), 'from')

    // `fromAccountId` defaults to `accounts[0]`, which the browser selects on
    // its own, so no `defaultValue` is passed and react-dom emits no marker.
    // Asserted rather than assumed: both selects list the same option values,
    // so a `defaultValue` accidentally added here would be invisible in a
    // document-wide substring check.
    expect(fromSelect).not.toContain('selected=""')
  })

  it('pre-selects exactly one option across the whole form', () => {
    const html = render([CASH, WALLET])

    expect(html.split('selected=""').length - 1).toBe(1)
  })

  it('renders a visible <label> for every field, including the account selects and date/note', () => {
    const html = render([CASH, WALLET])

    for (const [name, label] of [
      ['from', 'Từ'],
      ['to', 'Đến'],
      ['fromAmount', 'Số tiền'],
      ['date', 'Ngày và giờ'],
      ['note', 'Ghi chú'],
    ] as const) {
      const labelMatch = html.match(new RegExp(`<label for="transfer-${name}-[^"]*"`))
      expect(labelMatch, `<label> for transfer-${name}-*`).not.toBeNull()
      const labelIndex = html.indexOf(labelMatch![0])
      const labelEnd = html.indexOf('</label>', labelIndex)
      expect(html.slice(labelIndex, labelEnd)).toContain(label)
    }
  })

  it('shows one primary amount field for a same-currency pair, no destination amount entry', () => {
    const html = render([CASH, WALLET])

    expect(html).not.toMatch(/id="transfer-toAmount-/)
    // The single field's label is the generic "Amount", not "Amount sent".
    const labelMatch = html.match(/<label for="transfer-fromAmount-[^"]*"[^>]*>([^<]*)<\/label>/)
    expect(labelMatch?.[1]).toBe('Số tiền')
  })

  it('shows both amount fields, labelled by direction, for a cross-currency pair', () => {
    const html = render([CASH, USD_SAVINGS])

    const fromLabel = html.match(/<label for="transfer-fromAmount-[^"]*"[^>]*>([^<]*)<\/label>/)
    const toLabel = html.match(/<label for="transfer-toAmount-[^"]*"[^>]*>([^<]*)<\/label>/)
    expect(fromLabel?.[1]).toBe('Số tiền gửi')
    expect(toLabel?.[1]).toBe('Số tiền nhận')
  })
})

describe('TransferForm with fewer than two accounts', () => {
  it('renders nothing — the page replaces it with an EmptyState instead', () => {
    // Defence in depth (spec §6.3): the page is the one that decides whether
    // to mount this component at all, but a caller that somehow reaches it
    // with fewer than two accounts must not see two identical selects.
    expect(render([CASH])).toBe('')
    expect(render([])).toBe('')
  })
})
