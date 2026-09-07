import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, exactly like `components/debts/debt-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, every field being present and
 * labelled in the first paint rather than popping in after hydration, and — the
 * case this form exists to prove — that the frequency select's server-rendered
 * selection is MONTHLY even though MONTHLY is *not* its first option. That is
 * the exact shape of the defect `/transactions`' Type select once had: a
 * `<select>` whose browser fallback (the first option) disagreed with
 * `useForm`'s default, so a submission before hydration filed the loan on the
 * wrong schedule.
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

/** The user's own calendar day, as the page passes it in. */
const TODAY = '2026-04-15'

function render(): string {
  return renderToStaticMarkup(<LoanForm today={TODAY} />)
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

describe('LoanForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">New loan</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `DebtForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders every field, each labelled, in the first paint', () => {
    const html = render()

    for (const label of [
      'Lender',
      'Principal',
      'Loan currency',
      'Interest rate (%)',
      'Start date',
      'Term (months)',
      'Payment frequency',
      'Scheduled payment',
      'Next due date',
      'Notes',
    ]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('Add loan')
  })

  it('server-renders MONTHLY as the selected frequency, though it is not the first option', () => {
    const html = render()
    const frequencySelect = selectMarkup(html, 'Payment frequency')

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
    // Exactly one such select — the marker above is meaningless if a second
    // frequency control is hiding elsewhere in the form.
    expect(html.split('aria-label="Payment frequency"')).toHaveLength(2)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkup(html, 'Loan currency')

    // VND is the first option, and the marker is asserted anyway so the server
    // HTML states the form's own default rather than relying on a browser
    // fallback that happens to agree with it.
    expect(currencySelect).toMatch(selectedOption('VND'))
    expect(currencySelect).not.toMatch(selectedOption('USD'))
    expect(currencySelect).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.split('aria-label="Loan currency"')).toHaveLength(2)
  })

  it("pre-fills the next due date with the user's own today", () => {
    const nextDueDate = inputMarkup(render(), 'Next due date')

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
    expect(inputMarkup(html, 'Start date')).toContain('type="date"')
    expect(inputMarkup(html, 'Next due date')).toContain('type="date"')
  })

  it('starts the start date empty rather than guessing when the loan began', () => {
    // Unlike the next due date, there is no defensible default for a start
    // date: a loan began when it began, and today would be a fabricated term.
    expect(inputMarkup(render(), 'Start date')).not.toMatch(/\svalue=/)
  })

  it('starts every numeric field empty rather than pre-filling a zero', () => {
    const html = render()

    // A principal or a scheduled payment of 0 is the one value the schema
    // always rejects ("Amount must be greater than zero"), so neither may be
    // what the field starts at. A rate of 0 *is* valid — the interest-free loan
    // from family — but pre-filling it would state a term the user never gave,
    // and a term of 0 months is rejected outright.
    for (const label of ['Principal', 'Scheduled payment', 'Interest rate (%)', 'Term (months)']) {
      expect(inputMarkup(html, label)).not.toMatch(/\svalue=/)
    }
  })
})
