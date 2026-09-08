import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'

/**
 * A markup test, same rationale as `TransactionForm`'s: `renderToStaticMarkup`
 * is enough to pin down what the server ships before hydration — a disabled,
 * `aria-busy` fieldset and a visible `<label>` on every field — with no jsdom
 * and no Testing Library.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/server/actions/financial-account-actions', () => ({
  createFinancialAccountAction: vi.fn(),
}))

const { AccountForm } = await import('./account-form')

const ACCOUNT_TYPES = [
  { id: 'type_cash', name: 'Cash' },
  { id: 'type_bank', name: 'Bank' },
]

const messages = await loadMessages('vi')

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={messages}>
      <AccountForm accountTypes={ACCOUNT_TYPES} />
    </NextIntlClientProvider>,
  )
}

describe('AccountForm', () => {
  it('ships the form gated: a disabled, aria-busy fieldset', () => {
    const html = render()
    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('aria-busy="true"')
  })

  it('renders a visible <label for> on every field', () => {
    const html = render()
    const labelCount = (html.match(/<label for="/g) ?? []).length
    expect(labelCount).toBe(5)
  })

  it("defaults the account type <select> to its own first option, matching the form's default", () => {
    const html = render()
    const idMatch = html.match(/id="account-type-[^"]*"/)
    expect(idMatch).not.toBeNull()
    const start = html.lastIndexOf('<select', html.indexOf(idMatch![0]))
    const end = html.indexOf('</select>', start)
    const selectHtml = html.slice(start, end)
    const firstOption = selectHtml.match(/<option[^>]*>([^<]*)<\/option>/)
    expect(firstOption?.[1]).toBe('Cash')
  })
})
