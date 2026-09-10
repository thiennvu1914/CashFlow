import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * A markup test, not a DOM test: `renderToStaticMarkup` is enough to pin down
 * what the very first paint offers, with no jsdom and no Testing Library.
 *
 * `useTranslations` is mocked to echo its key rather than rendered through a
 * real `NextIntlClientProvider` — this test is about STRUCTURE (a label bound
 * to its field's id, no disabled first paint, a full-width primary), which
 * does not depend on the actual copy in `messages/{vi,en}/auth.json`.
 *
 * `useRouter` is only ever reached in the submit path, but calling it at all
 * throws outside a mounted Next app router, so it is mocked. The
 * `syncPreferenceCookies` server action is mocked too: importing the real one
 * pulls in Prisma and Better Auth for a test that never submits.
 */
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/server/actions/sync-preference-cookies', () => ({
  syncPreferenceCookies: vi.fn(),
}))

const { LoginForm } = await import('./login-form')

function render(): string {
  return renderToStaticMarkup(<LoginForm />)
}

/** The single `<button>` tag's own markup (attributes only), order-independent. */
function buttonMarkup(html: string): string {
  const start = html.indexOf('<button')
  if (start === -1) throw new Error('No <button> in the markup')
  const end = html.indexOf('>', start)
  return html.slice(start, end + 1)
}

describe('LoginForm', () => {
  it('gives both fields a visible label bound to their id', () => {
    const html = render()
    for (const id of ['login-email', 'login-password']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('has no defaultValues, so first paint must never disable the fieldset — a disabled first paint here would be the silent-reversion bug lib/ui/use-hydrated.ts documents, applied where it does not belong', () => {
    const html = render()
    expect(html).not.toMatch(/<fieldset disabled/)
  })

  it('renders the submit button full width inside the 400 px card', () => {
    const html = render()
    const button = buttonMarkup(html)
    expect(button).toContain('type="submit"')
    expect(button).toMatch(/class="[^"]*\bw-full\b/)
  })
})
