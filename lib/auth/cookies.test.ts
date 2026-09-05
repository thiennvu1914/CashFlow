import { describe, it, expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth } from './create-auth'

/**
 * Pins the session-cookie flags CashFlow relies on for an HTTPS deployment.
 * Nothing here configures cookies — the point is to prove that the
 * configuration we *do* have produces a `__Secure-`-prefixed, `HttpOnly`,
 * `Secure`, `SameSite=Lax` session cookie, so a later change that quietly loses
 * one of those flags fails a test instead of shipping.
 *
 * The prefix and the `Secure` attribute both derive from the base URL's scheme
 * (`createCookieGetter` in `node_modules/better-auth/dist/cookies/index.mjs`:
 * with no explicit `advanced.useSecureCookies`, `baseURL.startsWith('https://')`
 * decides), which is why this file builds an instance on an `https://` base URL
 * rather than the `http://localhost:3000` the other auth tests use.
 */
const BASE_URL = 'https://app.example.com'
const TEST_SECRET = 'cookies-unit-test-secret-32characters'

describe('session cookie flags on an https deployment', () => {
  it('issues a __Secure- prefixed HttpOnly, Secure, SameSite=Lax session cookie', async () => {
    const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
    const auth = createAuth({
      database: memoryAdapter(db),
      baseURL: BASE_URL,
      secret: TEST_SECRET,
      sendResetPasswordEmail: async () => {},
    })

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: BASE_URL,
          'x-forwarded-for': '203.0.113.200',
        },
        body: JSON.stringify({
          name: 'Cookie Test',
          email: 'cookie-test@example.com',
          password: 'correct-horse-battery-staple',
        }),
      }),
    )
    expect(response.status).toBe(200)

    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()

    const sessionCookie = (setCookie as string)
      .split(/,(?=[^;]+?=)/)
      .map((part) => part.trim())
      .find((part) => part.startsWith('__Secure-better-auth.session_token='))
    expect(sessionCookie).toBeTruthy()

    const attributes = (sessionCookie as string)
      .split(';')
      .slice(1)
      .map((attribute) => attribute.trim())

    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('Secure')
    expect(attributes).toContain('SameSite=Lax')
    expect(attributes).toContain('Path=/')
  })
})
