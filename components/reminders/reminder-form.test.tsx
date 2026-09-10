import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viLabels from '@/messages/vi/labels.json'
import viReminders from '@/messages/vi/reminders.json'

/**
 * A markup test, exactly like `components/debts/debt-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, every field being present and
 * VISIBLY labelled (a `<label for>`, not just an `aria-label` — spec §6.7's a11y
 * acceptance criterion for all twelve fields) in the first paint rather than
 * popping in after hydration, and — the case this form shares with the loan
 * form — that the frequency select's server-rendered selection is MONTHLY even
 * though MONTHLY is *not* its first option.
 *
 * It also pins the two conditional fields, which are this form's own hazard.
 * `createReminderSchema` *rejects* an anchor the frequency has no meaning for
 * (ruling R6-18: `month` is YEARLY-only, and rejected on MONTHLY too), so a
 * field that is on screen when it should not be is not a cosmetic problem — it
 * is a submission the schema refuses under a field the user was invited to
 * fill in.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the debt/loan tests.
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

const messages = await loadMessages('vi')

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <ReminderForm
        today={TODAY}
        locale="vi"
        expenseCategories={EXPENSE_CATEGORIES}
        incomeCategories={INCOME_CATEGORIES}
        accounts={ACCOUNTS}
      />
    </NextIntlClientProvider>,
  )
}

/** The markup of one `<select>`, found by an `id=` that starts with `prefix` —
 *  `<select>`s cannot nest, so the first `</select>` after the opening tag
 *  closes it. Ids are `useId()`-generated, so only the stable prefix this
 *  form's own `fieldId` helper writes can be matched. */
function selectMarkupById(html: string, prefix: string): string {
  const idMatch = html.match(new RegExp(`id="${prefix}-[^"]*"`))
  if (!idMatch) throw new Error(`No element whose id starts with "${prefix}-" in the markup`)
  const start = html.lastIndexOf('<select', html.indexOf(idMatch[0]))
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select> with id "${prefix}-…"`)
  return html.slice(start, end + '</select>'.length)
}

/** The opening tag of the one `<input>` whose id starts with `prefix`.
 *  `<input>` is a void element, so the tag is all there is. */
function inputMarkupById(html: string, prefix: string): string {
  const idMatch = html.match(new RegExp(`id="${prefix}-[^"]*"`))
  if (!idMatch) throw new Error(`No element whose id starts with "${prefix}-" in the markup`)
  const labelIndex = html.indexOf(idMatch[0])
  const start = html.lastIndexOf('<input', labelIndex)
  if (start === -1) throw new Error(`No <input> with id "${prefix}-…"`)
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
    expect(html).toContain(`<legend class="sr-only">${viReminders.createTitle}</legend>`)
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `LoanForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('renders a visible <label for> naming every one of the twelve fields, against the vi strings themselves', () => {
    const html = render()
    // title, type, expected amount, currency, frequency, interval, day of
    // month, start date, category, account, note — eleven at the default
    // frequency (month is YEARLY-only and not rendered under MONTHLY).
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(11)

    for (const label of [
      viReminders.titleField,
      viReminders.type,
      viReminders.expectedAmount,
      viReminders.currency,
      viReminders.frequency,
      viReminders.interval,
      viReminders.dayOfMonth,
      viReminders.startDate,
      viReminders.categoryOptional,
      viReminders.accountOptional,
      viReminders.note,
    ]) {
      expect(html).toContain(`>${label}</label>`)
    }
  })

  it('server-renders MONTHLY as the selected frequency, though it is not the first option', () => {
    const html = render()
    const frequency = selectMarkupById(html, 'reminder-frequency')

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
    expect(frequency.indexOf(`>${viLabels.recurrence.ONE_TIME}<`)).toBeLessThan(
      frequency.indexOf(`>${viLabels.recurrence.WEEKLY}<`),
    )
    expect(frequency.indexOf(`>${viLabels.recurrence.WEEKLY}<`)).toBeLessThan(
      frequency.indexOf(`>${viLabels.recurrence.MONTHLY}<`),
    )
    expect(frequency.indexOf(`>${viLabels.recurrence.MONTHLY}<`)).toBeLessThan(
      frequency.indexOf(`>${viLabels.recurrence.YEARLY}<`),
    )
    // Exactly one such select — the marker above is meaningless if a second
    // frequency control is hiding elsewhere in the form.
    expect(html.match(/id="reminder-frequency-[^"]*"/g)).toHaveLength(1)
  })

  it('server-renders EXPENSE as the selected type, and lists the bill first', () => {
    const html = render()
    const type = selectMarkupById(html, 'reminder-type')

    // EXPENSE is already the first option — a reminder is usually a bill — and
    // the marker is passed anyway so the server HTML states the form's own
    // default rather than relying on a browser fallback that happens to agree
    // with it. The row's own wording (`labels.reminderType.*`) is what names
    // it "Hóa đơn"/"Bill", not a form-only literal.
    expect(type).toMatch(selectedOption('EXPENSE'))
    expect(type).not.toMatch(selectedOption('INCOME'))
    expect(type).not.toMatch(/<select[^>]*\svalue=/)
    expect(type).toContain(`>${viLabels.reminderType.EXPENSE}<`)
    expect(type).toContain(`>${viLabels.reminderType.INCOME}<`)
    expect(type.indexOf('value="EXPENSE"')).toBeLessThan(type.indexOf('value="INCOME"'))
    expect(html.match(/id="reminder-type-[^"]*"/g)).toHaveLength(1)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currency = selectMarkupById(html, 'reminder-currency')

    expect(currency).toMatch(selectedOption('VND'))
    expect(currency).not.toMatch(selectedOption('USD'))
    expect(currency).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.match(/id="reminder-currency-[^"]*"/g)).toHaveLength(1)
  })

  it("pre-fills the start date with the user's own today", () => {
    const startDate = inputMarkupById(render(), 'reminder-start-date')

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
    expect(inputMarkupById(render(), 'reminder-expected-amount')).not.toMatch(/\svalue=/)
  })

  it("starts the interval at 1, bounded to what the schema accepts, with the frequency's own unit", () => {
    const html = render()
    const every = inputMarkupById(html, 'reminder-interval')

    expect(every).toContain('type="number"')
    expect(every).toContain('value="1"')
    // `min`/`max` mirror `createReminderSchema`'s own bounds, so the browser's
    // stepper cannot produce a value the schema then rejects.
    expect(every).toContain('min="1"')
    expect(every).toContain('max="99"')
    // The unit follows the frequency, so "Mỗi 2" is never ambiguous.
    expect(html).toContain(`>${viReminders.intervalUnitMonths}<`)
  })

  it('hides the Month field unless the frequency is YEARLY (ruling R6-18)', () => {
    const html = render()

    // The default is MONTHLY, and `createReminderSchema` *rejects* a month on
    // it: a monthly reminder recurs in every month, so it has no anchor month
    // to name. Rendering the field here would invite a value the schema
    // refuses.
    expect(html).not.toContain(`>${viReminders.month}</label>`)
    // The day of the month *is* meaningful for MONTHLY, and optional — the
    // service defaults it from the start date.
    expect(html).toContain(`>${viReminders.dayOfMonth}</label>`)
    expect(inputMarkupById(html, 'reminder-day-of-month')).not.toMatch(/\svalue=/)
  })

  it("offers only the selected type's categories, with None chosen", () => {
    const html = render()
    const category = selectMarkupById(html, 'reminder-category')

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
    expect(category).toMatch(new RegExp(`<option[^>]*selected=""[^>]*>${viReminders.none}<`))
  })

  it('offers the active accounts, with None chosen', () => {
    const account = selectMarkupById(render(), 'reminder-account')

    // The page passes `listActiveFinancialAccounts`, so this list is the user's
    // own ACTIVE accounts and nothing else; the component filters nothing.
    expect(account).toContain('>Vietcombank<')
    expect(account).toContain('>Cash wallet<')
    expect(account.indexOf('value=""')).toBeLessThan(account.indexOf('value="acc_vcb"'))
    expect(account).toMatch(new RegExp(`<option[^>]*selected=""[^>]*>${viReminders.none}<`))
  })

  it('renders a usable form with no categories and no accounts at all', () => {
    // Both fields are optional, so a brand-new user with neither must still be
    // able to add a reminder — unlike the transaction form, which has nothing
    // to record a transaction *to* without an account.
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
        <ReminderForm
          today={TODAY}
          locale="vi"
          expenseCategories={[]}
          incomeCategories={[]}
          accounts={[]}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain(`>${viReminders.titleField}</label>`)
    expect(html).toContain(viReminders.createAction)
    expect(selectMarkupById(html, 'reminder-category')).toMatch(
      new RegExp(`<option[^>]*selected=""[^>]*>${viReminders.none}<`),
    )
    expect(selectMarkupById(html, 'reminder-account')).toMatch(
      new RegExp(`<option[^>]*selected=""[^>]*>${viReminders.none}<`),
    )
  })
})
