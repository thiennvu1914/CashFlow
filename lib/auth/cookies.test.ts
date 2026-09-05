import { describe, it, expect } from 'vitest'
import { makeTestAuth, nextTestIp, signUp } from './__testing__/auth-harness'

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
 * decides), which is why this file overrides the harness's default
 * `http://localhost:3000` with an `https://` base URL.
 */
const BASE_URL = 'https://app.example.com'

describe('session cookie flags on an https deployment', () => {
  it('issues a __Secure- prefixed HttpOnly, Secure, SameSite=Lax session cookie', async () => {
    const { auth } = makeTestAuth({ baseURL: BASE_URL })

    const response = await signUp(
      auth,
      {
        name: 'Cookie Test',
        email: 'cookie-test@example.com',
        password: 'correct-horse-battery-staple',
      },
      { ip: nextTestIp(), baseURL: BASE_URL },
    )

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
