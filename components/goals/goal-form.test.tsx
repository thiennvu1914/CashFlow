import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, exactly like `components/budgets/budget-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and every field being present
 * and labelled in the first paint rather than popping in after hydration.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the budgets test.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/savings-goal-actions', () => ({
  createSavingsGoalAction: vi.fn(),
}))

const { GoalForm } = await import('./goal-form')

function render(): string {
  return renderToStaticMarkup(<GoalForm />)
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

describe('GoalForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">New savings goal</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `BudgetForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders every field, each labelled, in the first paint', () => {
    const html = render()

    for (const label of [
      'Goal name',
      'Target amount',
      'Current amount',
      'Goal currency',
      'Deadline',
      'Goal note',
    ]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('Add goal')
  })

  it('renders the deadline as a date input, so the browser submits yyyy-MM-dd', () => {
    const html = render()
    const deadlineIndex = html.indexOf('aria-label="Deadline"')
    const tagStart = html.lastIndexOf('<input', deadlineIndex)
    const deadlineInput = html.slice(tagStart, html.indexOf('>', deadlineIndex) + 1)

    // The one input whose DOM value format the schema depends on: an
    // `<input type="date">` submits `yyyy-MM-dd`, which is exactly what
    // `optionalCalendarDateSchema` accepts — and `''` when left untouched.
    expect(deadlineInput).toContain('type="date"')
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkup(html, 'Goal currency')

    // VND is already the first option, so the browser would land here anyway —
    // `defaultValue` is passed regardless, for symmetry with the debt and loan
    // forms of the later groups (whose defaults are NOT the first option) and
    // so this asserts what the component renders rather than what the browser
    // would fall back to.
    expect(currencySelect).toMatch(selectedOption('VND'))
    expect(currencySelect).not.toMatch(selectedOption('USD'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(currencySelect).not.toMatch(/<select[^>]*\svalue=/)
    // Exactly one such select — the marker above is meaningless if a second
    // currency control is hiding elsewhere in the form.
    expect(html.split('aria-label="Goal currency"')).toHaveLength(2)
  })

  it('starts the money fields empty rather than pre-filling a zero target', () => {
    const html = render()

    // A target of 0 is the one value the schema always rejects ("Target must be
    // greater than zero"), so it must never be what the field starts at; and
    // "how much have you already saved?" is a question the user may skip, which
    // an inserted 0 would answer for them.
    expect(html).not.toMatch(/aria-label="Target amount"[^>]*value=/)
    expect(html).not.toMatch(/aria-label="Current amount"[^>]*value=/)
  })
})
