import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, exactly like `components/loans/loan-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, every field being present and
 * labelled in the first paint rather than popping in after hydration, and — the
 * case this form shares with the loan form — that the frequency select's
 * server-rendered selection is MONTHLY even though MONTHLY is *not* its first
 * option.
 *
 * It also pins the two conditional fields, which are this form's own hazard.
 * `createReminderSchema` *rejects* an anchor the frequency has no meaning for
 * (ruling R6-18: `month` is YEARLY-only, and rejected on MONTHLY too), so a
 * field that is on screen when it should not be is not a cosmetic problem — it
 * is a submission the schema refuses under a field the user was invited to
 * fill in.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the loans test.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/reminder-actions', () => ({
  createReminderAction: vi.fn(),
}))

const { ReminderForm } = await import('./reminder-form')

/** The user's own calendar day, as the page passes it in. */
const TODAY = '2026-04-15'

const EXPENSE_CATEGORIES = [
  { id: 'cat_utilities', name: 'Utilities' },
  { id: 'cat_rent', name: 'Rent' },
]
const INCOME_CATEGORIES = [{ id: 'cat_salary', name: 'Salary' }]
const ACCOUNTS = [
  { id: 'acc_vcb', name: 'Vietcombank' },
  { id: 'acc_cash', name: 'Cash wallet' },
]

function render(): string {
  return renderToStaticMarkup(
    <ReminderForm
      today={TODAY}
      expenseCategories={EXPENSE_CATEGORIES}
      incomeCategories={INCOME_CATEGORIES}
      accounts={ACCOUNTS}
    />,
  )
}

/** The markup of one `<select>`, found by its `aria-label` — `<select>`s cannot
 *  nest, so the first `</select>` after the opening tag closes it. */
function selectMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<select', labelIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> labelled "${ariaLabel}"`)
  return html.slice(start, end + '</select>'.length)
}

/** The one `<input …>` tag carrying this `aria-label`. */
function inputMarkup(html: string, ariaLabel: string): string {
  const labelIndex = html.indexOf(`aria-label="${ariaLabel}"`)
  if (labelIndex === -1) throw new Error(`No element labelled "${ariaLabel}" in the markup`)
  const start = html.lastIndexOf('<input', labelIndex)
  if (start === -1) throw new Error(`No <input> labelled "${ariaLabel}"`)
  return html.slice(start, html.indexOf('>', labelIndex) + 1)
}

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('ReminderForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">New reminder</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `LoanForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders every field the default frequency needs, each labelled', () => {
    const html = render()

    for (const label of [
      'Title',
      'Type',
      'Expected amount',
      'Reminder currency',
      'Frequency',
      'Every',
      'Day of month',
      'Start date',
      'Category',
      'Account',
      'Note',
    ]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('Add reminder')
  })

  it('server-renders MONTHLY as the selected frequency, though it is not the first option', () => {
    const html = render()
    const frequency = selectMarkup(html, 'Frequency')

    // The case this test exists for. The options are in the Prisma enum's own
    // order (ONE_TIME, WEEKLY, MONTHLY, YEARLY) so the control reads as the
    // schema does, which puts the form's default *third* — and `register()`
    // emits no default of its own, so without an explicit `defaultValue` the
    // server HTML would select ONE_TIME while `useForm` held MONTHLY. A user
    // who submitted before hydration would then file a monthly bill as a
    // one-off and never be reminded again.
    expect(frequency).toMatch(selectedOption('MONTHLY'))
    expect(frequency).not.toMatch(selectedOption('ONE_TIME'))
    expect(frequency).not.toMatch(selectedOption('WEEKLY'))
    expect(frequency).not.toMatch(selectedOption('YEARLY'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(frequency).not.toMatch(/<select[^>]*\svalue=/)
    // The enum's order, stated as an assertion rather than left to the reader.
    expect(frequency.indexOf('value="ONE_TIME"')).toBeLessThan(frequency.indexOf('value="WEEKLY"'))
    expect(frequency.indexOf('value="WEEKLY"')).toBeLessThan(frequency.indexOf('value="MONTHLY"'))
    expect(frequency.indexOf('value="MONTHLY"')).toBeLessThan(frequency.indexOf('value="YEARLY"'))
    // Exactly one such select — the marker above is meaningless if a second
    // frequency control is hiding elsewhere in the form.
    expect(html.split('aria-label="Frequency"')).toHaveLength(2)
  })

  it('server-renders EXPENSE as the selected type, and lists the bill first', () => {
    const html = render()
    const type = selectMarkup(html, 'Type')

    // EXPENSE is already the first option — a reminder is usually a bill — and
    // the marker is passed anyway so the server HTML states the form's own
    // default rather than relying on a browser fallback that happens to agree
    // with it. The wording says "Bill (expense)" because the user is being
    // reminded of a bill, not shown a ledger entry that already exists.
    expect(type).toMatch(selectedOption('EXPENSE'))
    expect(type).not.toMatch(selectedOption('INCOME'))
    expect(type).not.toMatch(/<select[^>]*\svalue=/)
    expect(type).toContain('Bill (expense)')
    expect(type).toContain('Income')
    expect(type.indexOf('value="EXPENSE"')).toBeLessThan(type.indexOf('value="INCOME"'))
    expect(html.split('aria-label="Type"')).toHaveLength(2)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currency = selectMarkup(html, 'Reminder currency')

    expect(currency).toMatch(selectedOption('VND'))
    expect(currency).not.toMatch(selectedOption('USD'))
    expect(currency).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.split('aria-label="Reminder currency"')).toHaveLength(2)
  })

  it("pre-fills the start date with the user's own today", () => {
    const startDate = inputMarkup(render(), 'Start date')

    // `today` comes from `todayCalendarDateInZone` on the page, never from
    // `new Date()` in the browser — whose zone is not the profile's. It is
    // rendered as the input's value on the server so the field is already
    // filled in the first paint, and so the DOM and `useForm` agree before
    // hydration rather than after it.
    expect(startDate).toContain('type="date"')
    expect(startDate).toContain(`value="${TODAY}"`)
  })

  it('starts the expected amount empty rather than pre-filling a zero', () => {
    // A reminder for nothing is nothing to remind anyone of, and 0 is the one
    // value `createReminderSchema` always rejects — so it may not be what the
    // field starts at.
    expect(inputMarkup(render(), 'Expected amount')).not.toMatch(/\svalue=/)
  })

  it("starts the interval at 1, bounded to what the schema accepts, with the frequency's own unit", () => {
    const html = render()
    const every = inputMarkup(html, 'Every')

    expect(every).toContain('type="number"')
    expect(every).toContain('value="1"')
    // `min`/`max` mirror `createReminderSchema`'s own bounds, so the browser's
    // stepper cannot produce a value the schema then rejects.
    expect(every).toContain('min="1"')
    expect(every).toContain('max="99"')
    // The unit follows the frequency, so "Every 2" is never ambiguous.
    expect(html).toContain('>months<')
  })

  it('hides the Month field unless the frequency is YEARLY (ruling R6-18)', () => {
    const html = render()

    // The default is MONTHLY, and `createReminderSchema` *rejects* a month on
    // it: a monthly reminder recurs in every month, so it has no anchor month
    // to name. Rendering the field here would invite a value the schema
    // refuses.
    expect(html).not.toContain('aria-label="Month"')
    // The day of the month *is* meaningful for MONTHLY, and optional — the
    // service defaults it from the start date.
    expect(html).toContain('aria-label="Day of month"')
    expect(inputMarkup(html, 'Day of month')).not.toMatch(/\svalue=/)
  })

  it("offers only the selected type's categories, with None chosen", () => {
    const html = render()
    const category = selectMarkup(html, 'Category')

    // The default type is EXPENSE, so an INCOME category must not be on offer:
    // the service refuses a category whose type does not match the reminder's
    // (`InvalidReminderCategoryError`), and offering one would be a choice that
    // can only fail.
    expect(category).toContain('>Utilities<')
    expect(category).toContain('>Rent<')
    expect(category).not.toContain('>Salary<')
    // Optional, and the placeholder is the *first* option and the selected one,
    // so an untouched form sends no category at all.
    expect(category.indexOf('value=""')).toBeLessThan(category.indexOf('value="cat_utilities"'))
    expect(category).toMatch(/<option[^>]*selected=""[^>]*>None</)
  })

  it('offers the active accounts, with None chosen', () => {
    const account = selectMarkup(render(), 'Account')

    // The page passes `listActiveFinancialAccounts`, so this list is the user's
    // own ACTIVE accounts and nothing else; the component filters nothing.
    expect(account).toContain('>Vietcombank<')
    expect(account).toContain('>Cash wallet<')
    expect(account.indexOf('value=""')).toBeLessThan(account.indexOf('value="acc_vcb"'))
    expect(account).toMatch(/<option[^>]*selected=""[^>]*>None</)
  })

  it('renders a usable form with no categories and no accounts at all', () => {
    // Both fields are optional, so a brand-new user with neither must still be
    // able to add a reminder — unlike the transaction form, which has nothing
    // to record a transaction *to* without an account.
    const html = renderToStaticMarkup(
      <ReminderForm today={TODAY} expenseCategories={[]} incomeCategories={[]} accounts={[]} />,
    )

    expect(html).toContain('aria-label="Title"')
    expect(html).toContain('Add reminder')
    expect(selectMarkup(html, 'Category')).toMatch(/<option[^>]*selected=""[^>]*>None</)
    expect(selectMarkup(html, 'Account')).toMatch(/<option[^>]*selected=""[^>]*>None</)
  })
})
