import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Currency } from '@prisma/client'

/**
 * A markup test, not a DOM test: `renderToStaticMarkup` is enough to pin down
 * *what the user is offered* on first paint — which is the whole defect here (an
 * empty, apparently usable Account `<select>`) — with no jsdom and no Testing
 * Library, i.e. no new dependency for one component.
 *
 * `useRouter` is only ever called in the submit path, but calling it at all
 * throws outside a mounted Next app router, so it is mocked. The server action
 * module is mocked too: importing the real one pulls in Prisma and Better Auth
 * for a test that never submits.
 *
 * `next/link` is NOT mocked, but note what that does and does not prove. Node
 * resolution (`next/link` → `next/dist/client/link.js`) yields the
 * *pages-router* Link, which renders without a router because of its own
 * `if (!router)` guards. The app ships a different file —
 * `next/dist/client/app-dir/link.js`, substituted by Next's compiler alias —
 * which dereferences the app-router context. Both emit the same `<a href>`, so
 * the `href="/accounts"` assertions below are true of the markup *shape*; that
 * the Link the app actually bundles navigates is proved by
 * `e2e/transactions-empty-state.spec.ts`, not here.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/transaction-actions', () => ({
  createTransactionAction: vi.fn(),
}))

const { TransactionForm } = await import('./transaction-form')

type Account = { id: string; name: string; currency: Currency }

/** The user's configured zone — only used to pre-fill the date field. */
const TIMEZONE = 'Asia/Ho_Chi_Minh'

const CATEGORIES = [
  { id: 'cat_food', name: 'Food & Dining', type: 'EXPENSE' as const },
  { id: 'cat_salary', name: 'Salary', type: 'INCOME' as const },
]

const NOTICE = 'You need an account before you can add a transaction.'

function render(accounts: Account[]): string {
  return renderToStaticMarkup(
    <TransactionForm accounts={accounts} categories={CATEGORIES} timezone={TIMEZONE} />,
  )
}

/**
 * The markup of one `<select>`, found by its `aria-label` — `<select>`s cannot
 * nest, so the first `</select>` after the opening tag closes it. Scoping to
 * this slice is what makes an option *count* meaningful: the form renders three
 * other selects (type, category), each with options of its own.
 */
function selectMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<select', labelIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> labelled "${ariaLabel}"`)
  return html.slice(start, end + '</select>'.length)
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1
}

/** Every option's visible text, in document order. */
function optionLabels(selectHtml: string): string[] {
  return [...selectHtml.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
}

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('TransactionForm with no accounts', () => {
  it('replaces the whole form with a notice and a link to /accounts', () => {
    const html = render([])

    expect(html).toContain(NOTICE)
    expect(html).toContain('href="/accounts"')
    expect(html).toContain('Go to Accounts')
  })

  it('offers no Account selector, no form and no submit action', () => {
    const html = render([])

    // The defect: an empty `<select aria-label="Account">` looks usable and is
    // not. None of it may be rendered — not the select, not the surrounding
    // form, not the submit button that would fail validation.
    expect(html).not.toContain('aria-label="Account"')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<option')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Add transaction')
  })

  it('leaks no raw validator text', () => {
    const html = render([])

    expect(html).not.toMatch(/expected string|>=1 characters|Too small|Invalid input/i)
  })
})

describe('TransactionForm with active accounts', () => {
  it('lists a single account as exactly one option and keeps the form usable', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND' }])
    const accountSelect = selectMarkup(html, 'Account')

    expect(countOf(accountSelect, '<option')).toBe(1)
    expect(optionLabels(accountSelect)).toEqual(['Cash'])
    expect(html).toContain('Add transaction')
    expect(html).not.toContain(NOTICE)
    // The currency hint follows the selected account, which on first render is
    // the form's default — the first account in the prop.
    expect(html).toContain('>VND</span>')
  })

  it('lists three accounts as exactly three options, in prop order', () => {
    const html = render([
      { id: 'acc_cash', name: 'Cash', currency: 'VND' },
      { id: 'acc_wallet', name: 'Wallet', currency: 'USD' },
      { id: 'acc_savings', name: 'Savings', currency: 'VND' },
    ])
    const accountSelect = selectMarkup(html, 'Account')

    expect(countOf(accountSelect, '<option')).toBe(3)
    expect(optionLabels(accountSelect)).toEqual(['Cash', 'Wallet', 'Savings'])
    expect(html).toContain('>VND</span>')
  })

  /**
   * The server HTML is where the hydration-race fix has to be visible: the
   * first bytes the browser paints are the only thing standing between the
   * user and a control that would silently discard what they typed. See
   * `lib/ui/use-hydrated.ts` for the react-hook-form/React interaction, and
   * `e2e/transaction-form-hydration.spec.ts` for the same three facts checked
   * against a real server response plus the behaviour they buy.
   */
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND' }])

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">Transaction details</legend>')
  })

  it('moves the form layout onto the fieldset, so lifting the gate shifts nothing', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND' }])

    // The flex column lives on the fieldset (the new flex container), not on
    // the <form> — a `<fieldset>` wrapping a flex form's children without
    // taking over its layout would re-flow every field the moment it appears.
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
    expect(html).not.toMatch(/<form[^>]*class=/)
  })

  it('server-renders the real Type default, EXPENSE, as the selected option', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND' }])
    const typeSelect = selectMarkup(html, 'Transaction type')

    // `register()` emits no value/defaultValue of its own
    // (`react-hook-form/dist/index.esm.mjs:3118-3183`), so without an explicit
    // `defaultValue` the browser would show the FIRST option — Income — while
    // form state, and the Category list below, already said EXPENSE.
    expect(typeSelect).toMatch(selectedOption('EXPENSE'))
    expect(typeSelect).not.toMatch(selectedOption('INCOME'))
    // Exactly one Type option is pre-selected, and it is not a `value=` prop
    // on the <select> itself — that would make the control controlled.
    expect(countOf(typeSelect, 'selected=""')).toBe(1)
    expect(typeSelect).not.toMatch(/<select[^>]*\svalue=/)
  })

  it('lists the EXPENSE categories, matching the EXPENSE default', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND' }])
    const categorySelect = selectMarkup(html, 'Category')

    // HTML-escaped, because this is markup: "Food & Dining" → "Food &amp; Dining".
    expect(optionLabels(categorySelect)).toEqual(['Select a category', 'Food &amp; Dining'])
    // The placeholder is the pre-selected one — nothing is chosen for the user.
    expect(categorySelect).toMatch(selectedOption(''))
    expect(categorySelect).not.toMatch(selectedOption('cat_food'))
  })

  it('renders exactly the accounts it is given — no filtering of its own', () => {
    // Every row here is ACTIVE-shaped, which is all this component is ever
    // handed: `app/(app)/transactions/page.tsx` passes
    // `listActiveFinancialAccounts`. That archived accounts never reach this
    // list is deliberately NOT asserted here — it is proved where the filtering
    // happens, by `lib/server/services/financial-account.test.ts`
    // ("listActiveFinancialAccounts excludes an ARCHIVED row") and end-to-end by
    // `e2e/transactions-empty-state.spec.ts`. This case only pins down that the
    // component adds no filtering, renaming or re-ordering of its own.
    const accounts: Account[] = [
      { id: 'acc_b', name: 'Bank', currency: 'VND' },
      { id: 'acc_a', name: 'Cash', currency: 'VND' },
    ]
    const accountSelect = selectMarkup(render(accounts), 'Account')

    expect(optionLabels(accountSelect)).toEqual(accounts.map((a) => a.name))
    expect(countOf(accountSelect, '<option')).toBe(accounts.length)
  })
})
