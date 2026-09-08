import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viLabels from '@/messages/vi/labels.json'

/**
 * A markup test, exactly like `components/goals/goal-form.test.tsx` —
 * `renderToStaticMarkup`, no jsdom, no Testing Library, no new dependency.
 *
 * What it pins down is the server HTML, which is where this form's half of the
 * hydration-race fix lives (`lib/ui/use-hydrated.ts`): the gate that stops the
 * form accepting input it would silently discard, and every field being present
 * and VISIBLY labelled (a `<label for>`, not just an `aria-label`) in the first
 * paint rather than popping in after hydration.
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

const messages = await loadMessages('vi')

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <DebtForm />
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

describe('DebtForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render()

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('sr-only')
    // The flex column lives on the fieldset, so nothing re-flows when the gate
    // lifts (same guarantee as `GoalForm`'s).
    expect(html).toContain('class="flex min-w-0 flex-col gap-3"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
  })

  it('renders a visible <label for> on every field', () => {
    const html = render()
    // direction, person, original amount, currency, due date, description, notes.
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(7)
  })

  it('renders the due date as a date input, so the browser submits yyyy-MM-dd', () => {
    const html = render()
    const dueDateInput = inputMarkupById(html, 'debt-due-date')

    // The one input whose DOM value format the schema depends on: an
    // `<input type="date">` submits `yyyy-MM-dd`, which is exactly what
    // `optionalCalendarDateSchema` accepts — and `''` when left untouched.
    expect(dueDateInput).toContain('type="date"')
  })

  it('server-renders RECEIVABLE as the selected direction, worded like the row itself', () => {
    const html = render()
    const directionSelect = selectMarkupById(html, 'debt-direction')

    // RECEIVABLE is already the first option, so react-dom would land here even
    // with no marker at all — `defaultValue` is passed regardless, for symmetry
    // with the money forms whose defaults are NOT first, and so this asserts
    // what the component renders rather than what the browser falls back to.
    expect(directionSelect).toMatch(selectedOption('RECEIVABLE'))
    expect(directionSelect).not.toMatch(selectedOption('PAYABLE'))
    // Uncontrolled: a `value=` prop on the <select> would make it controlled.
    expect(directionSelect).not.toMatch(/<select[^>]*\svalue=/)
    // The row's own wording (`labels.debtDirection.*`), not the old form-only
    // "Someone owes me"/"I owe someone" — the deliberate copy unification.
    expect(directionSelect).toContain(viLabels.debtDirection.RECEIVABLE)
    expect(directionSelect).toContain(viLabels.debtDirection.PAYABLE)
    expect(directionSelect).not.toContain('Someone owes me')
    expect(directionSelect).not.toContain('I owe someone')
    // Exactly one such select.
    expect(html.match(/id="debt-direction-[^"]*"/g)).toHaveLength(1)
  })

  it('server-renders VND as the selected currency, from a single currency select', () => {
    const html = render()
    const currencySelect = selectMarkupById(html, 'debt-currency')

    // Same reasoning as the direction select: VND is the first option, and the
    // marker is asserted so the server HTML states the form's own default.
    expect(currencySelect).toMatch(selectedOption('VND'))
    expect(currencySelect).not.toMatch(selectedOption('USD'))
    expect(currencySelect).not.toMatch(/<select[^>]*\svalue=/)
    expect(html.match(/id="debt-currency-[^"]*"/g)).toHaveLength(1)
  })

  it('starts the amount field empty rather than pre-filling a zero', () => {
    const html = render()

    // An original amount of 0 is the one value the schema always rejects
    // ("Amount must be greater than zero"), so it must never be what the field
    // starts at.
    expect(inputMarkupById(html, 'debt-original-amount')).not.toContain('value=')
  })
})
