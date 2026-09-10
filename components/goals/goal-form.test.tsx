import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'

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

const messages = await loadMessages('vi')

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <GoalForm />
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

describe('GoalForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('sr-only')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `BudgetForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('renders a visible <label for> on every field', () => {
    const html = render()
    // name, target, current, currency, deadline, note.
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(6)
  })

  it('renders the deadline as a date input, so the browser submits yyyy-MM-dd', () => {
    const html = render()
    const deadlineInput = inputMarkupById(html, 'goal-deadline')

    // The one input whose DOM value format the schema depends on: an
    // `<input type="date">` submits `yyyy-MM-dd`, which is exactly what
    // `optionalCalendarDateSchema` accepts — and `''` when left untouched.
    expect(deadlineInput).toContain('type="date"')
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkupById(html, 'goal-currency')

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
    expect(html.match(/id="goal-currency-[^"]*"/g)).toHaveLength(1)
  })

  it('starts the money fields empty rather than pre-filling a zero target', () => {
    const html = render()

    // A target of 0 is the one value the schema always rejects ("Target must be
    // greater than zero"), so it must never be what the field starts at; and
    // "how much have you already saved?" is a question the user may skip, which
    // an inserted 0 would answer for them.
    expect(inputMarkupById(html, 'goal-target')).not.toContain('value=')
    expect(inputMarkupById(html, 'goal-current')).not.toContain('value=')
  })
})
