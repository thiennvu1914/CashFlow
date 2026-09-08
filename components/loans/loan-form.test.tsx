import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viLabels from '@/messages/vi/labels.json'
import viLoans from '@/messages/vi/loans.json'

/**
 * A markup test, exactly like `components/debts/debt-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, every field being present and
 * VISIBLY labelled (a `<label for>`, not just an `aria-label`) in the first
 * paint rather than popping in after hydration, and — the case this form exists
 * to prove — that the frequency select's server-rendered selection is MONTHLY
 * even though MONTHLY is *not* its first option. That is the exact shape of the
 * defect `/transactions`' Type select once had: a `<select>` whose browser
 * fallback (the first option) disagreed with `useForm`'s default, so a
 * submission before hydration filed the loan on the wrong schedule.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the debts test.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/loan-actions', () => ({
  createLoanAction: vi.fn(),
}))

const { LoanForm } = await import('./loan-form')

const messages = await loadMessages('vi')

/** The user's own calendar day, as the page passes it in. */
const TODAY = '2026-04-15'

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <LoanForm today={TODAY} />
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
  const end = html.indexOf('>', labelIndex)
  if (start === -1 || end === -1) throw new Error(`No <input> with id "${prefix}-…"`)
  return html.slice(start, end + 1)
}

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('LoanForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('sr-only')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `DebtForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('renders a visible <label for> naming every field, against the vi strings themselves', () => {
    const html = render()
    // lender, principal, currency, interest rate, start date, term months,
    // payment frequency, scheduled payment, next due date, notes.
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(10)

    for (const label of [
      viLoans.lender,
      viLoans.principal,
      viLoans.currency,
      viLoans.interestRate,
      viLoans.startDate,
      viLoans.termMonths,
      viLoans.paymentFrequency,
      viLoans.scheduledPayment,
      viLoans.nextDueDate,
      viLoans.notes,
    ]) {
      expect(html).toContain(`>${label}</label>`)
    }
  })

  it('server-renders MONTHLY as the selected frequency, though it is not the first option', () => {
    const html = render()
    const frequencySelect = selectMarkupById(html, 'loan-payment-frequency')

    // The case this test exists for. The options are in the Prisma enum's own
    // order (WEEKLY, MONTHLY, YEARLY) so the control reads as the schema does,
    // which puts the form's default *second* — and `register()` emits no
    // default of its own, so without an explicit `defaultValue` the server HTML
    // would select WEEKLY while `useForm` held MONTHLY. A user who submitted
    // before hydration would then file a monthly loan as weekly.
    expect(frequencySelect).toMatch(selectedOption('MONTHLY'))
    expect(frequencySelect).not.toMatch(selectedOption('WEEKLY'))
    expect(frequencySelect).not.toMatch(selectedOption('YEARLY'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(frequencySelect).not.toMatch(/<select[^>]*\svalue=/)
    // The enum's order, stated as an assertion rather than left to the reader.
    expect(frequencySelect.indexOf('value="WEEKLY"')).toBeLessThan(
      frequencySelect.indexOf('value="MONTHLY"'),
    )
    expect(frequencySelect.indexOf('value="MONTHLY"')).toBeLessThan(
      frequencySelect.indexOf('value="YEARLY"'),
    )
    // The user's own words for the cadence, never the raw enum.
    expect(frequencySelect).toContain(viLabels.paymentFrequency.MONTHLY)
    // Exactly one such select — the marker above is meaningless if a second
    // frequency control is hiding elsewhere in the form.
    expect(html.match(/id="loan-payment-frequency-[^"]*"/g)).toHaveLength(1)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkupById(html, 'loan-currency')

    // VND is the first option, and the marker is asserted anyway so the server
    // HTML states the form's own default rather than relying on a browser
    // fallback that happens to agree with it.
    expect(currencySelect).toMatch(selectedOption('VND'))
    expect(currencySelect).not.toMatch(selectedOption('USD'))
    expect(currencySelect).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.match(/id="loan-currency-[^"]*"/g)).toHaveLength(1)
  })

  it("pre-fills the next due date with the user's own today", () => {
    const nextDueDate = inputMarkupById(render(), 'loan-next-due-date')

    // `today` comes from `todayCalendarDateInZone` on the page, never from
    // `new Date()` in the browser — whose zone is not the profile's. It is
    // rendered as the input's value on the server so the field is already
    // filled in the first paint, and so the DOM and `useForm` agree before
    // hydration rather than after it.
    expect(nextDueDate).toContain('type="date"')
    expect(nextDueDate).toContain(`value="${TODAY}"`)
  })

  it('renders both loan dates as date inputs, so the browser submits yyyy-MM-dd', () => {
    const html = render()

    // The two inputs whose DOM value format the schema depends on: an
    // `<input type="date">` submits `yyyy-MM-dd`, which is exactly what
    // `calendarDateStringSchema` accepts.
    expect(inputMarkupById(html, 'loan-start-date')).toContain('type="date"')
    expect(inputMarkupById(html, 'loan-next-due-date')).toContain('type="date"')
  })

  it('starts the start date empty rather than guessing when the loan began', () => {
    // Unlike the next due date, there is no defensible default for a start
    // date: a loan began when it began, and today would be a fabricated term.
    expect(inputMarkupById(render(), 'loan-start-date')).not.toContain('value=')
  })

  it('starts every numeric field empty rather than pre-filling a zero', () => {
    const html = render()

    // A principal or a scheduled payment of 0 is the one value the schema
    // always rejects ("Amount must be greater than zero"), so neither may be
    // what the field starts at. A rate of 0 *is* valid — the interest-free loan
    // from family — but pre-filling it would state a term the user never gave,
    // and a term of 0 months is rejected outright.
    for (const prefix of [
      'loan-principal',
      'loan-scheduled-payment',
      'loan-interest-rate',
      'loan-term-months',
    ]) {
      expect(inputMarkupById(html, prefix)).not.toContain('value=')
    }
  })
})
