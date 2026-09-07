import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, exactly like `components/transactions/transaction-form.test.tsx`
 * — `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and the scope `<select>`
 * whose default flips to CATEGORY — the *second* option — once an Overall
 * budget already exists for the month.
 *
 * `useRouter` throws outside a mounted app router and the action module pulls
 * in Prisma, so both are mocked — same reasoning as the transactions test.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/budget-actions', () => ({
  createBudgetAction: vi.fn(),
}))

const { BudgetForm } = await import('./budget-form')

const CATEGORIES = [
  { id: 'cat_food', name: 'Food & Dining' },
  { id: 'cat_bills', name: 'Bills & Utilities' },
]

function render(overallExists: boolean): string {
  return renderToStaticMarkup(
    <BudgetForm year={2026} month={9} categories={CATEGORIES} overallExists={overallExists} />,
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

/** `<option value="…" … selected="">` regardless of attribute order — the
 *  order react-dom happens to emit attributes in is not what is under test. */
function selectedOption(value: string): RegExp {
  return new RegExp(
    `<option[^>]*\\svalue="${value}"[^>]*\\sselected=""|<option[^>]*\\sselected=""[^>]*\\svalue="${value}"`,
  )
}

describe('BudgetForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render(false)

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">Budget details</legend>')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `TransactionForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('server-renders CATEGORY as selected when an Overall budget already exists', () => {
    const html = render(true)
    const scopeSelect = selectMarkup(html, 'Budget scope')

    // The branch that actually needed `defaultValue`: CATEGORY is the SECOND
    // option, so without it the browser would show "Overall" — a scope that
    // can only ever fail as DUPLICATE_BUDGET — while form state said CATEGORY.
    expect(scopeSelect).toMatch(selectedOption('CATEGORY'))
    expect(scopeSelect).not.toMatch(selectedOption('OVERALL'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(scopeSelect).not.toMatch(/<select[^>]*\svalue=/)
    // And the CATEGORY-only field is server-rendered too, because `useWatch`
    // reads the same default — no post-hydration pop-in.
    expect(html).toContain('aria-label="Budget category"')
  })

  it('server-renders OVERALL as selected when no Overall budget exists yet', () => {
    const html = render(false)
    const scopeSelect = selectMarkup(html, 'Budget scope')

    // OVERALL is already the first option, so the browser would land here
    // anyway — but react-dom still emits the marker for whatever `defaultValue`
    // names, so this asserts what the component actually renders rather than
    // what the browser would fall back to. Either way server and form agree.
    expect(scopeSelect).toMatch(selectedOption('OVERALL'))
    expect(scopeSelect).not.toMatch(selectedOption('CATEGORY'))
    // Scope OVERALL carries no category, so that select is absent entirely.
    expect(html).not.toContain('aria-label="Budget category"')
  })

  it('leaves the currency select with no pre-selected option — its default IS the first', () => {
    const currencySelect = selectMarkup(render(false), 'Budget currency')

    // `currency` defaults to 'VND', already the first option, so no
    // `defaultValue` is passed and react-dom emits no marker.
    expect(currencySelect).not.toContain('selected=""')
  })

  it('pre-selects the category placeholder, never a category, on the CATEGORY branch', () => {
    const categorySelect = selectMarkup(render(true), 'Budget category')

    expect(categorySelect).toContain('<option value="" selected="">Select a category</option>')
    expect(categorySelect).not.toMatch(selectedOption('cat_food'))
  })
})
