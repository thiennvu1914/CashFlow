import { describe, it, expect } from 'vitest'
import {
  makeTestAuth,
  nextTestIp,
  signUp,
  signIn,
  sessionUser,
  requestPasswordReset,
  resetPassword,
  TEST_BASE_URL,
  type TestAuth,
} from './__testing__/auth-harness'

/**
 * These tests exercise the real Better Auth reset-password flow against an
 * in-memory database and a fake email sender, so they need neither Postgres,
 * SMTP nor the network. They never import `lib/prisma.ts` or `lib/auth/auth.ts`
 * (the app singleton) for that reason — see
 * `lib/auth/__testing__/auth-harness.ts`, which also explains why every request
 * carries its own fake `x-forwarded-for` IP.
 *
 * They pin the whole forgot/reset round trip the UI depends on: the emailed URL
 * really is produced, an unregistered email is indistinguishable from a
 * registered one, the token actually rotates the password, and it is single
 * use.
 */
const TEST_EMAIL = 'reset-test@example.com'
const OLD_PASSWORD = 'correct-horse-battery-staple'
const NEW_PASSWORD = 'a-brand-new-passphrase-9000'
const REDIRECT_TO = '/reset-password'

function signUpTestUser(auth: TestAuth, ip: string) {
  return signUp(auth, { name: 'Reset Test', email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })
}

function requestReset(auth: TestAuth, ip: string, email: string) {
  return requestPasswordReset(auth, { email, redirectTo: REDIRECT_TO }, { ip })
}

/**
 * Follows the emailed link exactly as a browser would: Better Auth's
 * `GET /api/auth/reset-password/:token?callbackURL=…` verifies the token and
 * redirects to the app route with `?token=…` (or `?error=INVALID_TOKEN`). The
 * reset page reads that query parameter, so the test extracts it the same way.
 */
async function followResetLink(auth: TestAuth, ip: string, emailedUrl: string) {
  const response = await auth.handler(
    new Request(emailedUrl, { headers: { origin: TEST_BASE_URL, 'x-forwarded-for': ip } }),
  )
  const location = response.headers.get('location')
  expect(location).toBeTruthy()
  return new URL(location as string)
}

describe('forgot / reset password HTTP surface', () => {
  it('emails exactly one reset link to a registered address', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await requestReset(auth, ip, TEST_EMAIL)

    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(TEST_EMAIL)

    // The link points at Better Auth's own verify-and-redirect endpoint,
    // `/api/auth/reset-password/<token>?callbackURL=/reset-password` — it is
    // not a direct link to the app route.
    const url = new URL(sent[0].url)
    expect(url.origin).toBe(TEST_BASE_URL)
    expect(url.pathname.startsWith('/api/auth/reset-password/')).toBe(true)
    expect(url.pathname.slice('/api/auth/reset-password/'.length)).toBeTruthy()
    expect(url.searchParams.get('callbackURL')).toBe(REDIRECT_TO)
  })

  it('answers an unregistered email identically and sends nothing (no account enumeration)', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const registered = await requestReset(auth, ip, TEST_EMAIL)
    expect(sent).toHaveLength(1)

    const unregistered = await requestReset(auth, ip, 'never-registered@example.com')

    expect(unregistered.status).toBe(registered.status)
    expect(unregistered.status).toBe(200)
    expect(await unregistered.json()).toEqual(await registered.json())
    // Nothing new was sent — the only message is still the registered one.
    expect(sent).toHaveLength(1)
  })

  it('redirects the emailed link to the app reset route carrying the token', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestReset(auth, ip, TEST_EMAIL)

    const redirected = await followResetLink(auth, ip, sent[0].url)

    expect(redirected.origin).toBe(TEST_BASE_URL)
    expect(redirected.pathname).toBe(REDIRECT_TO)
    expect(redirected.searchParams.get('token')).toBeTruthy()
    expect(redirected.searchParams.get('error')).toBeNull()
  })

  it('rotates the password: the old one stops working and the new one signs in', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    const reset = await resetPassword(auth, { token, newPassword: NEW_PASSWORD }, { ip })
    expect(reset.status).toBe(200)

    const withOldPassword = await signIn(
      auth,
      { email: TEST_EMAIL, password: OLD_PASSWORD },
      { ip },
    )
    expect(withOldPassword.status).toBe(401)
    expect(withOldPassword.headers.get('set-cookie')).toBeFalsy()

    const withNewPassword = await signIn(
      auth,
      { email: TEST_EMAIL, password: NEW_PASSWORD },
      { ip },
    )
    expect(withNewPassword.status).toBe(200)
    expect(withNewPassword.headers.get('set-cookie')).toBeTruthy()
  })

  it('revokes sessions that existed before the reset', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    // A session held from before the reset — this is the one an attacker who
    // already knew the old password would be sitting on.
    const signInResponse = await signIn(auth, { email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })
    expect(signInResponse.status).toBe(200)
    const staleCookie = signInResponse.headers.get('set-cookie') as string
    expect(staleCookie).toBeTruthy()
    expect(await sessionUser(auth, { ip, cookie: staleCookie })).toBeTruthy()

    await requestReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string
    expect((await resetPassword(auth, { token, newPassword: NEW_PASSWORD }, { ip })).status).toBe(
      200,
    )

    expect(await sessionUser(auth, { ip, cookie: staleCookie })).toBeNull()
  })

  it('rejects a token that has already been used (single use)', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    expect((await resetPassword(auth, { token, newPassword: NEW_PASSWORD }, { ip })).status).toBe(
      200,
    )

    const replay = await resetPassword(
      auth,
      { token, newPassword: 'yet-another-passphrase-1234' },
      { ip },
    )
    expect(replay.status).not.toBe(200)
    expect(replay.status).toBe(400)

    // The replay attempt did not take effect either.
    expect(
      (await signIn(auth, { email: TEST_EMAIL, password: 'yet-another-passphrase-1234' }, { ip }))
        .status,
    ).toBe(401)
    expect((await signIn(auth, { email: TEST_EMAIL, password: NEW_PASSWORD }, { ip })).status).toBe(
      200,
    )
  })

  it('rejects a garbage token', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await resetPassword(
      auth,
      { token: 'not-a-real-token', newPassword: NEW_PASSWORD },
      { ip },
    )

    expect(response.status).not.toBe(200)
    expect(response.status).toBe(400)
    expect((await signIn(auth, { email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })).status).toBe(
      200,
    )
  })

  it('rejects a new password shorter than the 8-character minimum', async () => {
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    const response = await resetPassword(auth, { token, newPassword: 'short' }, { ip })

    expect(response.status).toBe(400)
    expect((await signIn(auth, { email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })).status).toBe(
      200,
    )
  })
})
