import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import type { Currency } from '@prisma/client'
import { loadMessages } from '@/lib/i18n/messages'

/**
 * A markup test, not a DOM test: `renderToStaticMarkup` is enough to pin down
 * *what the user is offered* on first paint — which is the whole defect here (an
 * empty, apparently usable Account picker) — with no jsdom and no Testing
 * Library, i.e. no new dependency for one component.
 *
 * `useRouter` is only ever called in the submit path, but calling it at all
 * throws outside a mounted Next app router, so it is mocked. The server action
 * module is mocked too: importing the real one pulls in Prisma and Better Auth
 * for a test that never submits.
 *
 * `next/link` is NOT mocked — see the identical reasoning this file used to
 * carry, still true: Node resolution yields the pages-router Link, which
 * renders without a router because of its own `if (!router)` guards, and it
 * emits the same `<a href>` markup the app-router Link does.
 *
 * Rendered inside a real `NextIntlClientProvider` fed the actual `vi` message
 * tree (`loadMessages`), so every string asserted below is the actual product
 * copy, not a stand-in.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/transaction-actions', () => ({
  createTransactionAction: vi.fn(),
}))

const { TransactionForm } = await import('./transaction-form')

type Account = { id: string; name: string; currency: Currency; balance: string }

/** The user's configured zone — only used to pre-fill the date/time fields. */
const TIMEZONE = 'Asia/Ho_Chi_Minh'

const CATEGORIES = [
  { id: 'cat_food', name: 'Food & Dining', type: 'EXPENSE' as const },
  { id: 'cat_salary', name: 'Salary', type: 'INCOME' as const },
]

const NOTICE = 'Bạn cần ít nhất một tài khoản để ghi giao dịch.'

const messages = await loadMessages('vi')

function render(accounts: Account[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone={TIMEZONE} messages={messages}>
      <TransactionForm
        accounts={accounts}
        categories={CATEGORIES}
        timezone={TIMEZONE}
        locale="vi"
      />
    </NextIntlClientProvider>,
  )
}

/**
 * The markup of one `<select>`, found by its `id` — `<select>`s cannot nest,
 * so the first `</select>` after the opening tag closes it. Every select this
 * form renders pre-hydration carries a unique `id` (`FormField`'s contract),
 * which is what makes this scoping meaningful.
 */
function selectMarkup(html: string, id: string): string {
  const idIndex = html.indexOf(`id="${id}"`)
  if (idIndex === -1) throw new Error(`No element with id "${id}" in the markup`)
  const start = html.lastIndexOf('<select', idIndex)
  const end = html.indexOf('</select>', start)
  if (start === -1 || end === -1) throw new Error(`No <select id="${id}">`)
  return html.slice(start, end + '</select>'.length)
}

/**
 * The markup of the type radiogroup's PRIMARY row — from `role="radiogroup"`
 * up to the first `</div>`, which (the two `TypeButton`s and the "Khác"
 * disclosure button are all plain `<button>`s with no nested `<div>`) is
 * exactly the `<div className="flex gap-2">` wrapper that holds them, and
 * nothing of the disclosure panel beyond it.
 */
function radiogroupMarkup(html: string): string {
  const start = html.indexOf('role="radiogroup"')
  if (start === -1) throw new Error('No radiogroup in the markup')
  const end = html.indexOf('</div>', start)
  return html.slice(start, end)
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1
}

/** Every option's visible text, in document order. */
function optionLabels(selectHtml: string): string[] {
  return [...selectHtml.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
}

describe('TransactionForm with no accounts', () => {
  it('replaces the whole form with a notice and a link to /accounts', () => {
    const html = render([])

    expect(html).toContain(NOTICE)
    expect(html).toContain('href="/accounts"')
    expect(html).toContain('Đến Tài khoản')
  })

  it('offers no Account selector, no form and no submit action', () => {
    const html = render([])

    // The defect: an empty Account picker looks usable and is not. None of it
    // may be rendered — not a select, not the surrounding form, not the submit
    // button that would fail validation.
    expect(html).not.toContain('id="transaction-account"')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<option')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Thêm giao dịch')
  })

  it('leaks no raw validator text', () => {
    const html = render([])

    expect(html).not.toMatch(/expected string|>=1 characters|Too small|Invalid input/i)
  })
})

describe('TransactionForm with active accounts', () => {
  it('shows the notice-free form and its currency hint follows the default account', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])

    expect(html).toContain('Thêm giao dịch')
    expect(html).not.toContain(NOTICE)
    // The currency hint follows the selected account, which on first render is
    // the form's default — the first account in the prop.
    expect(html).toContain('>VND</span>')
  })

  /**
   * The server HTML is where the hydration-race fix has to be visible: the
   * first bytes the browser paints are the only thing standing between the
   * user and a control that would silently discard what they typed. See
   * `lib/ui/use-hydrated.ts` for the react-hook-form/React interaction, and
   * `e2e/transaction-form-hydration.spec.ts` for the same facts checked
   * against a real server response plus the behaviour they buy.
   */
  it('ships the form gated: a disabled, aria-busy fieldset with an sr-only legend', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])

    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<legend class="sr-only">Thêm giao dịch</legend>')
  })

  it('moves the form layout onto the fieldset, so lifting the gate shifts nothing', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])

    // The flex column lives on the fieldset (the new flex container), not on
    // the <form> — a `<fieldset>` wrapping a flex form's children without
    // taking over its layout would re-flow every field the moment it appears.
    expect(html).toContain('class="flex min-w-0 flex-col gap-4"')
    expect(html).toMatch(/<form[^>]*>\s*<fieldset/)
    expect(html).not.toMatch(/<form[^>]*class=/)
  })

  it('server-renders the real Type default, EXPENSE, as the checked radio', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])
    const typeGroup = radiogroupMarkup(html)

    // The Type the client is about to own is the Type the server showed —
    // the radiogroup analogue of the old `<select>`'s `selected` marker.
    expect(typeGroup).toMatch(/aria-checked="true"[^>]*>Chi tiêu/)
    expect(typeGroup).not.toMatch(/aria-checked="true"[^>]*>Thu nhập/)
    // Exactly one radio is checked.
    expect(countOf(typeGroup, 'aria-checked="true"')).toBe(1)
  })

  it('shows the Category picker gated behind its own disabled stand-in, offering only the placeholder', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])
    const categorySelect = selectMarkup(html, 'transaction-category')

    expect(categorySelect).toContain('disabled')
    // Nothing is pre-chosen for the user; the placeholder is the only option.
    expect(optionLabels(categorySelect)).toEqual(['Chọn danh mục'])
  })

  it('renders the account stand-in carrying the form default, matching prop order', () => {
    const accounts: Account[] = [
      { id: 'acc_b', name: 'Bank', currency: 'VND', balance: '2000000.00' },
      { id: 'acc_a', name: 'Cash', currency: 'VND', balance: '500000.00' },
    ]
    const accountSelect = selectMarkup(render(accounts), 'transaction-account')

    // Exactly one option pre-hydration — the form's own default (`accounts[0]`,
    // "Bank"), not a full option list a native `<select>` would carry: the
    // hydrated control is a custom Select with no uncontrolled DOM equivalent,
    // so the stand-in shows only what the form state actually holds.
    expect(countOf(accountSelect, '<option')).toBe(1)
    expect(accountSelect).toContain('disabled')
    expect(optionLabels(accountSelect)[0]).toContain('Bank')
  })

  it('pre-fills the split date and time from nowInZone', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])

    expect(html).toMatch(/id="transaction-date"[^>]*value="\d{4}-\d{2}-\d{2}"/)
    expect(html).toMatch(/id="transaction-time"[^>]*value="\d{2}:\d{2}"/)
  })

  it('renders a visible <label> for every field, including the split date and time', () => {
    const html = render([{ id: 'acc_cash', name: 'Cash', currency: 'VND', balance: '1000000.00' }])

    for (const [id, label] of [
      ['transaction-amount', 'Số tiền'],
      ['transaction-account', 'Tài khoản'],
      ['transaction-category', 'Danh mục'],
      ['transaction-date', 'Ngày'],
      ['transaction-time', 'Giờ'],
      ['transaction-note', 'Ghi chú'],
    ] as const) {
      expect(html).toContain(`<label for="${id}"`)
      const labelIndex = html.indexOf(`<label for="${id}"`)
      const labelEnd = html.indexOf('</label>', labelIndex)
      expect(html.slice(labelIndex, labelEnd)).toContain(label)
    }
  })
})
