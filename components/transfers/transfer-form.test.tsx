import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Currency } from '@prisma/client'

/**
 * A markup test, exactly like `components/transactions/transaction-form.test.tsx`
 * — `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and the one `<select>` whose
 * form default is not its first option.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the transactions test.
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

function render(accounts: Account[]): string {
  return renderToStaticMarkup(<TransferForm accounts={accounts} timezone={TIMEZONE} />)
}

/** The markup of one `<select>`, found by its `aria-label` — `<select>`s cannot
 *  nest, so the first `</select>` after the opening tag closes it. Scoping
 *  matters here more than anywhere: both account selectors render the SAME
 *  option values, and only one of them may carry a pre-selected option. */
function selectMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<select', labelIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> labelled "${ariaLabel}"`)
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
    expect(html).toContain('<legend class="sr-only">Transfer details</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `TransactionForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders the To account default — the SECOND account — as selected', () => {
    const toSelect = selectMarkup(render([CASH, WALLET]), 'To account')

    // A transfer defaults to moving money *between* accounts, so `toAccountId`
    // is `accounts[1]` — not the first option. Without `defaultValue` the
    // browser would show "Cash" while form state already said "Wallet".
    expect(toSelect).toMatch(selectedOption(WALLET.id))
    expect(toSelect).not.toMatch(selectedOption(CASH.id))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(toSelect).not.toMatch(/<select[^>]*\svalue=/)
  })

  it('leaves the From account select with no pre-selected option — its default IS the first', () => {
    const fromSelect = selectMarkup(render([CASH, WALLET]), 'From account')

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

  it('falls back to the only account when there is just one, still with a marker', () => {
    // `defaultToAccountId` is `accounts[1] ?? accounts[0] ?? ''`, so a
    // single-account list makes "to" the same account as "from". The form is
    // unusable in that state either way (the server rejects a self-transfer),
    // but the markup must not silently disagree with form state.
    const toSelect = selectMarkup(render([CASH]), 'To account')

    expect(toSelect).toMatch(selectedOption(CASH.id))
  })
})
