import { describe, it, expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth } from './create-auth'

/**
 * These tests exercise the real Better Auth instance against an in-memory
 * database, so they need neither Postgres nor the network. They never import
 * `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton) for that reason.
 *
 * They pin the HTTP-level sign-in / sign-out behaviour the login and logout
 * UI (Task 4) relies on: a correct-password sign-in issues a session cookie,
 * a wrong password and an unregistered email both fail the same way (no
 * account-enumeration via status code), and sign-out revokes the session
 * server-side rather than merely asking the browser to drop the cookie.
 *
 * Task 8 turned on real rate limiting (`lib/auth/create-auth.ts`), which is
 * keyed on `<ip>|<path>` and, with no IP header, falls back to a single
 * shared `127.0.0.1` bucket per path for the whole file (Better Auth's
 * `getIP` fallback in test/dev — see `rate-limit.test.ts` for the citation).
 * Each `it()` below therefore gets its own fake `x-forwarded-for` IP so the
 * handful of sign-up/sign-in calls one test makes are never mistaken for many
 * requests from one caller and tripped up by Better Auth's built-in
 * sign-up/sign-in rate-limit rules.
 */
const BASE_URL = 'http://localhost:3000'
const TEST_SECRET = 'sign-in-unit-test-secret-32characters'
const TEST_EMAIL = 'sign-in-test@example.com'
const TEST_PASSWORD = 'correct-horse-battery-staple'

let ipCounter = 0
function nextTestIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

function makeAuth() {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] }
  const auth = createAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    sendResetPasswordEmail: async () => {},
  })
  return { auth, db }
}

async function signUpTestUser(auth: ReturnType<typeof createAuth>, ip: string) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({
        name: 'Sign In Test',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    }),
  )
  expect(response.status).toBe(200)
}

function signInRequest(ip: string, email: string, password: string) {
  return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  })
}

function getSessionRequest(ip: string, cookie: string) {
  return new Request(`${BASE_URL}/api/auth/get-session`, {
    method: 'GET',
    headers: { origin: BASE_URL, 'x-forwarded-for': ip, cookie },
  })
}

describe('sign-in / sign-out HTTP surface', () => {
  it('signs in with the correct password and returns a usable session cookie', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await auth.handler(signInRequest(ip, TEST_EMAIL, TEST_PASSWORD))
    expect(response.status).toBe(200)

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toBeTruthy()

    const sessionResponse = await auth.handler(getSessionRequest(ip, cookie as string))
    expect(sessionResponse.status).toBe(200)
    const session = (await sessionResponse.json()) as { user: { id: string; email: string } }
    expect(session.user).toMatchObject({ email: TEST_EMAIL })
    expect(session.user.id).toBeTruthy()
  })

  it('rejects a wrong password with 401 and sets no session cookie', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const response = await auth.handler(signInRequest(ip, TEST_EMAIL, 'totally-wrong-password'))
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeFalsy()
  })

  it('rejects an unregistered email with the same status as a wrong password (no account enumeration)', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const wrongPassword = await auth.handler(
      signInRequest(ip, TEST_EMAIL, 'totally-wrong-password'),
    )
    const neverRegistered = await auth.handler(
      signInRequest(ip, 'never-registered@example.com', 'irrelevant-password'),
    )

    expect(neverRegistered.status).toBe(wrongPassword.status)
    expect(neverRegistered.status).toBe(401)
    expect(neverRegistered.headers.get('set-cookie')).toBeFalsy()
  })

  it('revokes the session server-side on sign-out, not just client-side', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)

    const signInResponse = await auth.handler(signInRequest(ip, TEST_EMAIL, TEST_PASSWORD))
    const cookie = signInResponse.headers.get('set-cookie') as string
    expect(cookie).toBeTruthy()

    // Confirm the session is live before signing out.
    const beforeSignOut = await auth.handler(getSessionRequest(ip, cookie))
    expect(beforeSignOut.status).toBe(200)
    expect(((await beforeSignOut.json()) as { user: unknown } | null)?.user).toBeTruthy()

    const signOutResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin: BASE_URL, 'x-forwarded-for': ip, cookie },
      }),
    )
    expect(signOutResponse.status).toBe(200)

    // The same old cookie must no longer resolve to a user — the session was
    // revoked server-side, not merely cleared client-side.
    const afterSignOut = await auth.handler(getSessionRequest(ip, cookie))
    expect(afterSignOut.status).toBe(200)
    const afterBody = (await afterSignOut.text()) as string
    expect(afterBody === '' || afterBody === 'null' ? null : JSON.parse(afterBody)).toBeNull()
  })
})
