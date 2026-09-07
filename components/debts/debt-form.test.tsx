import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, exactly like `components/goals/goal-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and every field being present
 * and labelled in the first paint rather than popping in after hydration.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the goals test.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/debt-actions', () => ({
  createDebtAction: vi.fn(),
}))

const { DebtForm } = await import('./debt-form')

function render(): string {
  return renderToStaticMarkup(<DebtForm />)
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

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('DebtForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">New debt</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `GoalForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders every field, each labelled, in the first paint', () => {
    const html = render()

    for (const label of [
      'Direction',
      'Person',
      'Original amount',
      'Debt currency',
      'Due date',
      'Description',
      'Notes',
    ]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('Add debt')
  })

  it('renders the due date as a date input, so the browser submits yyyy-MM-dd', () => {
    const html = render()
    const dueDateIndex = html.indexOf('aria-label="Due date"')
    const tagStart = html.lastIndexOf('<input', dueDateIndex)
    const dueDateInput = html.slice(tagStart, html.indexOf('>', dueDateIndex) + 1)

    // The one input whose DOM value format the schema depends on: an
    // `<input type="date">` submits `yyyy-MM-dd`, which is exactly what
    // `optionalCalendarDateSchema` accepts — and `''` when left untouched.
    expect(dueDateInput).toContain('type="date"')
  })

  it('server-renders "Someone owes me" as the selected direction', () => {
    const html = render()
    const directionSelect = selectMarkup(html, 'Direction')

    // RECEIVABLE is already the first option, so react-dom would land here even
    // with no marker at all — `defaultValue` is passed regardless, for symmetry
    // with the money forms whose defaults are NOT first, and so this asserts
    // what the component renders rather than what the browser falls back to.
    // It matters because `useForm`'s own default is RECEIVABLE: if the two ever
    // disagreed, a user who submitted before hydration would file the debt in
    // the wrong direction (the defect `lib/ui/use-hydrated.ts` documents).
    expect(directionSelect).toMatch(selectedOption('RECEIVABLE'))
    expect(directionSelect).not.toMatch(selectedOption('PAYABLE'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(directionSelect).not.toMatch(/<select[^>]*\svalue=/)
    // The user's own words on both sides of the agreement, never the enum.
    expect(directionSelect).toContain('Someone owes me')
    expect(directionSelect).toContain('I owe someone')
    // Exactly one such select — the marker above is meaningless if a second
    // direction control is hiding elsewhere in the form.
    expect(html.split('aria-label="Direction"')).toHaveLength(2)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkup(html, 'Debt currency')

    // Same reasoning as the direction select: VND is the first option, and the
    // marker is asserted so the server HTML states the form's own default.
    expect(currencySelect).toMatch(selectedOption('VND'))
    expect(currencySelect).not.toMatch(selectedOption('USD'))
    expect(currencySelect).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.split('aria-label="Debt currency"')).toHaveLength(2)
  })

  it('starts the amount field empty rather than pre-filling a zero', () => {
    const html = render()

    // An original amount of 0 is the one value the schema always rejects
    // ("Amount must be greater than zero"), so it must never be what the field
    // starts at.
    expect(html).not.toMatch(/aria-label="Original amount"[^>]*value=/)
  })
})
