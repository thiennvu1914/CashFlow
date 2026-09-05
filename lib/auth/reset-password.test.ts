import { describe, it, expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth } from './create-auth'

/**
 * These tests exercise the real Better Auth reset-password flow against an
 * in-memory database and a fake email sender, so they need neither Postgres,
 * SMTP nor the network. They never import `lib/prisma.ts` or `lib/auth/auth.ts`
 * (the app singleton) for that reason.
 *
 * They pin the whole forgot/reset round trip the UI depends on: the emailed URL
 * really is produced, an unregistered email is indistinguishable from a
 * registered one, the token actually rotates the password, and it is single
 * use.
 *
 * Task 8 turned on real rate limiting (`lib/auth/create-auth.ts`), which is
 * keyed on `<ip>|<path>` and, with no IP header, falls back to a single
 * shared `127.0.0.1` bucket per path for the whole file (Better Auth's
 * `getIP` fallback in test/dev — see `rate-limit.test.ts` for the citation).
 * Each `it()` below therefore gets its own fake `x-forwarded-for` IP so the
 * handful of sign-up/request-password-reset calls one test makes are never
 * mistaken for many requests from one caller and tripped up by Better Auth's
 * built-in sign-up rate-limit rule.
 */
const BASE_URL = 'http://localhost:3000'
const TEST_SECRET = 'reset-password-unit-test-secret-32ch'
const TEST_EMAIL = 'reset-test@example.com'
const OLD_PASSWORD = 'correct-horse-battery-staple'
const NEW_PASSWORD = 'a-brand-new-passphrase-9000'
const REDIRECT_TO = '/reset-password'

interface SentEmail {
  to: string
  url: string
}

let ipCounter = 0
function nextTestIp(): string {
  ipCounter += 1
  return `192.0.2.${ipCounter}`
}

function makeAuth() {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
  const sent: SentEmail[] = []
  const auth = createAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    sendResetPasswordEmail: async (to, url) => {
      sent.push({ to, url })
    },
  })
  return { auth, db, sent }
}

type Auth = ReturnType<typeof createAuth>

async function signUpTestUser(auth: Auth, ip: string) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({
        name: 'Reset Test',
        email: TEST_EMAIL,
        password: OLD_PASSWORD,
      }),
    }),
  )
  expect(response.status).toBe(200)
}

function requestPasswordReset(auth: Auth, ip: string, email: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, redirectTo: REDIRECT_TO }),
    }),
  )
}

function resetPassword(auth: Auth, ip: string, token: string, newPassword: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({ newPassword, token }),
    }),
  )
}

function signIn(auth: Auth, ip: string, email: string, password: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    }),
  )
}

function getSessionRequest(ip: string, cookie: string) {
  return new Request(`${BASE_URL}/api/auth/get-session`, {
    method: 'GET',
    headers: { origin: BASE_URL, 'x-forwarded-for': ip, cookie },
  })
}

/**
 * `get-session` answers 200 with an empty/`null` body once the session is gone,
 * so "no user" is what has to be asserted, not a status code.
 */
async function sessionUser(auth: Auth, ip: string, cookie: string) {
  const response = await auth.handler(getSessionRequest(ip, cookie))
  expect(response.status).toBe(200)
  const body = await response.text()
  const parsed = body === '' || body === 'null' ? null : (JSON.parse(body) as { user?: unknown })
  return parsed?.user ?? null
}

/**
 * Follows the emailed link exactly as a browser would: Better Auth's
 * `GET /api/auth/reset-password/:token?callbackURL=…` verifies the token and
 * redirects to the app route with `?token=…` (or `?error=INVALID_TOKEN`). The
 * reset page reads that query parameter, so the test extracts it the same way.
 */
async function followResetLink(auth: Auth, ip: string, emailedUrl: string) {
  const response = await auth.handler(
    new Request(emailedUrl, { headers: { origin: BASE_URL, 'x-forwarded-for': ip } }),
  )
  const location = response.headers.get('location')
  expect(location).toBeTruthy()
  return new URL(location as string)
}

describe('forgot / reset password HTTP surface', () => {
  it('emails exactly one reset link to a registered address', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await requestPasswordReset(auth, ip, TEST_EMAIL)

    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(TEST_EMAIL)

    // The link points at Better Auth's own verify-and-redirect endpoint,
    // `/api/auth/reset-password/<token>?callbackURL=/reset-password` — it is
    // not a direct link to the app route.
    const url = new URL(sent[0].url)
    expect(url.origin).toBe(BASE_URL)
    expect(url.pathname.startsWith('/api/auth/reset-password/')).toBe(true)
    expect(url.pathname.slice('/api/auth/reset-password/'.length)).toBeTruthy()
    expect(url.searchParams.get('callbackURL')).toBe(REDIRECT_TO)
  })

  it('answers an unregistered email identically and sends nothing (no account enumeration)', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const registered = await requestPasswordReset(auth, ip, TEST_EMAIL)
    expect(sent).toHaveLength(1)

    const unregistered = await requestPasswordReset(auth, ip, 'never-registered@example.com')

    expect(unregistered.status).toBe(registered.status)
    expect(unregistered.status).toBe(200)
    expect(await unregistered.json()).toEqual(await registered.json())
    // Nothing new was sent — the only message is still the registered one.
    expect(sent).toHaveLength(1)
  })

  it('redirects the emailed link to the app reset route carrying the token', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestPasswordReset(auth, ip, TEST_EMAIL)

    const redirected = await followResetLink(auth, ip, sent[0].url)

    expect(redirected.origin).toBe(BASE_URL)
    expect(redirected.pathname).toBe(REDIRECT_TO)
    expect(redirected.searchParams.get('token')).toBeTruthy()
    expect(redirected.searchParams.get('error')).toBeNull()
  })

  it('rotates the password: the old one stops working and the new one signs in', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestPasswordReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    const reset = await resetPassword(auth, ip, token, NEW_PASSWORD)
    expect(reset.status).toBe(200)

    const withOldPassword = await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)
    expect(withOldPassword.status).toBe(401)
    expect(withOldPassword.headers.get('set-cookie')).toBeFalsy()

    const withNewPassword = await signIn(auth, ip, TEST_EMAIL, NEW_PASSWORD)
    expect(withNewPassword.status).toBe(200)
    expect(withNewPassword.headers.get('set-cookie')).toBeTruthy()
  })

  it('revokes sessions that existed before the reset', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    // A session held from before the reset — this is the one an attacker who
    // already knew the old password would be sitting on.
    const signInResponse = await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)
    expect(signInResponse.status).toBe(200)
    const staleCookie = signInResponse.headers.get('set-cookie') as string
    expect(staleCookie).toBeTruthy()
    expect(await sessionUser(auth, ip, staleCookie)).toBeTruthy()

    await requestPasswordReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string
    expect((await resetPassword(auth, ip, token, NEW_PASSWORD)).status).toBe(200)

    expect(await sessionUser(auth, ip, staleCookie)).toBeNull()
  })

  it('rejects a token that has already been used (single use)', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestPasswordReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    expect((await resetPassword(auth, ip, token, NEW_PASSWORD)).status).toBe(200)

    const replay = await resetPassword(auth, ip, token, 'yet-another-passphrase-1234')
    expect(replay.status).not.toBe(200)
    expect(replay.status).toBe(400)

    // The replay attempt did not take effect either.
    expect((await signIn(auth, ip, TEST_EMAIL, 'yet-another-passphrase-1234')).status).toBe(401)
    expect((await signIn(auth, ip, TEST_EMAIL, NEW_PASSWORD)).status).toBe(200)
  })

  it('rejects a garbage token', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await resetPassword(auth, ip, 'not-a-real-token', NEW_PASSWORD)

    expect(response.status).not.toBe(200)
    expect(response.status).toBe(400)
    expect((await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)).status).toBe(200)
  })

  it('rejects a new password shorter than the 8-character minimum', async () => {
    const { auth, sent } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    await requestPasswordReset(auth, ip, TEST_EMAIL)
    const token = (await followResetLink(auth, ip, sent[0].url)).searchParams.get('token') as string

    const response = await resetPassword(auth, ip, token, 'short')

    expect(response.status).toBe(400)
    expect((await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)).status).toBe(200)
  })
})
