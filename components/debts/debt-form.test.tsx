import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viDebts from '@/messages/vi/debts.json'
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

const ACCOUNTS = [
  { id: 'acc_wallet', name: 'Ví tiền mặt', currency: 'VND' as const },
  { id: 'acc_usd', name: 'Savings USD', currency: 'USD' as const },
]

function render(
  props: Partial<{
    accounts: typeof ACCOUNTS
    defaultAccountId: string | null
    baseCurrency: 'VND' | 'USD'
  }> = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <DebtForm
        accounts={props.accounts ?? ACCOUNTS}
        defaultAccountId={
          props.defaultAccountId === undefined ? 'acc_wallet' : props.defaultAccountId
        }
        baseCurrency={props.baseCurrency ?? 'VND'}
        today="2026-10-12"
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

  it('renders a visible <label for> naming every field, against the vi strings themselves', () => {
    const html = render()
    // direction, person, original amount, account, money-moved-on, currency,
    // due date, description, notes.
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(9)

    for (const label of [
      viDebts.direction,
      viDebts.person,
      viDebts.originalAmount,
      viDebts.account,
      viDebts.movedOn,
      viDebts.currency,
      viDebts.dueDate,
      viDebts.descriptionField,
      viDebts.notes,
    ]) {
      expect(html).toContain(`>${label}</label>`)
    }
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

  it("offers 'don't record in an account' first, then the active accounts, pre-selecting the default", () => {
    const html = render()
    const accountSelect = selectMarkupById(html, 'debt-account')

    expect(accountSelect).toMatch(/<option value=""[^>]*>Không ghi vào tài khoản<\/option>/)
    expect(accountSelect.indexOf('Không ghi vào tài khoản')).toBeLessThan(
      accountSelect.indexOf('Ví tiền mặt'),
    )
    expect(accountSelect).toContain('Ví tiền mặt · VND')
    expect(accountSelect).toContain('Savings USD · USD')
    expect(accountSelect).toMatch(selectedOption('acc_wallet'))
    expect(accountSelect).not.toMatch(selectedOption('acc_usd'))
    expect(accountSelect).not.toMatch(/<select[^>]*\svalue=/)
  })

  it("pre-selects 'don't record' when there is no default account, and shows no money-moved-on date", () => {
    const html = render({ defaultAccountId: null, accounts: [] })
    const accountSelect = selectMarkupById(html, 'debt-account')

    expect(accountSelect).toMatch(selectedOption(''))
    expect(accountSelect.match(/<option/g)).toHaveLength(1)
    // No account: no money-moved-on date.
    expect(html).not.toContain(`>${viDebts.movedOn}</label>`)
    expect(html).not.toMatch(/id="debt-moved-on-/)
  })

  it('shows the money-moved-on date, defaulting to today, once an account is chosen', () => {
    const html = render()
    const movedOn = inputMarkupById(html, 'debt-moved-on')

    expect(movedOn).toContain('type="date"')
    expect(movedOn).toContain('value="2026-10-12"')
  })

  it('shows the account currency read-only while an account is chosen, never the VND/USD select', () => {
    const html = render()

    expect(html).not.toMatch(/<select[^>]*id="debt-currency-/)
    const currency = inputMarkupById(html, 'debt-currency')
    expect(currency).toContain('value="VND"')
    expect(currency).toContain('readOnly=""')
    expect(html).toContain(viDebts.currencyFromAccount)
    // The field's own id, not its `-helper` paragraph's.
    expect(html.match(/id="debt-currency-[^"]*(?<!-helper)"/g)).toHaveLength(1)
  })

  it("shows the currency select only when 'don't record' is chosen, defaulting to the base currency", () => {
    const vnd = render({ defaultAccountId: null })
    const vndSelect = selectMarkupById(vnd, 'debt-currency')
    expect(vndSelect).toMatch(selectedOption('VND'))
    expect(vndSelect).not.toMatch(selectedOption('USD'))
    expect(vndSelect).not.toMatch(/<select[^>]*\svalue=/)
    expect(vnd.match(/id="debt-currency-[^"]*"/g)).toHaveLength(1)

    const usd = selectMarkupById(
      render({ defaultAccountId: null, baseCurrency: 'USD' }),
      'debt-currency',
    )
    expect(usd).toMatch(selectedOption('USD'))
    expect(usd).not.toMatch(selectedOption('VND'))
  })

  it('takes the read-only currency from the pre-selected account, not the base currency', () => {
    const html = render({ defaultAccountId: 'acc_usd', baseCurrency: 'VND' })
    expect(inputMarkupById(html, 'debt-currency')).toContain('value="USD"')
  })

  it('starts the amount field empty rather than pre-filling a zero', () => {
    const html = render()

    // An original amount of 0 is the one value the schema always rejects
    // ("Amount must be greater than zero"), so it must never be what the field
    // starts at.
    expect(inputMarkupById(html, 'debt-original-amount')).not.toContain('value=')
  })
})
