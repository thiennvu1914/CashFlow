import { describe, expect, it, vi } from 'vitest'

/**
 * `register-form.tsx` is a client component; importing it pulls in
 * `next-intl`, `next/navigation` and the Better Auth client, none of which
 * this test exercises. They are mocked so the one thing under test — the
 * error-code → message-key mapping, which is what decides whether this form
 * leaks the existence of an account — can be asserted directly.
 */
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/auth/client', () => ({ authClient: { signUp: { email: vi.fn() } } }))

const { registerErrorKey } = await import('./register-form')

describe('registerErrorKey', () => {
  it('maps BOTH duplicate-address codes to the same key an unknown failure gets — no enumeration oracle', () => {
    const unknown = registerErrorKey({ code: 'SOMETHING_ELSE', status: 500 })
    expect(unknown).toBe('auth.registerFailed')
    expect(registerErrorKey({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', status: 422 })).toBe(
      unknown,
    )
    expect(registerErrorKey({ code: 'USER_ALREADY_EXISTS', status: 422 })).toBe(unknown)
    expect(registerErrorKey(undefined)).toBe(unknown)
    expect(registerErrorKey({})).toBe(unknown)
  })

  it('keeps the too-many-attempts message for a 429, whatever code rides with it', () => {
    expect(registerErrorKey({ status: 429 })).toBe('auth.tooManyAttempts')
    // A 429 is a fact about this client's request rate, not about any
    // account, so it stays distinguishable on purpose (Task 13, D3).
    expect(registerErrorKey({ code: 'USER_ALREADY_EXISTS', status: 429 })).toBe(
      'auth.tooManyAttempts',
    )
  })

  it('never returns the retired auth.emailTaken key', () => {
    const keys = [
      registerErrorKey({ code: 'USER_ALREADY_EXISTS' }),
      registerErrorKey({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }),
      registerErrorKey({ status: 500 }),
      registerErrorKey({ status: 429 }),
    ]
    expect(keys).not.toContain('auth.emailTaken')
  })
})

describe('the localized copy behind the key', () => {
  it('exists in both dictionaries, says nothing about the address existing, and offers a next step', async () => {
    const [vi, en] = await Promise.all([
      import('@/messages/vi/auth.json'),
      import('@/messages/en/auth.json'),
    ])
    const messages = { vi: vi.default.registerFailed, en: en.default.registerFailed }

    for (const [locale, text] of Object.entries(messages)) {
      expect(text, locale).toBeTruthy()
      expect(text, locale).not.toMatch(/already exists|đã có tài khoản/i)
    }
    expect(messages.en).toContain('sign in')
    expect(messages.vi).toContain('đăng nhập')
    // The key it replaces must be gone from both files, not just unused.
    expect(vi.default).not.toHaveProperty('emailTaken')
    expect(en.default).not.toHaveProperty('emailTaken')
  })
})
