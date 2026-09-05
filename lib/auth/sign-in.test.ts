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
 */
const BASE_URL = 'http://localhost:3000'
const TEST_SECRET = 'sign-in-unit-test-secret-32characters'
const TEST_EMAIL = 'sign-in-test@example.com'
const TEST_PASSWORD = 'correct-horse-battery-staple'

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

async function signUpTestUser(auth: ReturnType<typeof createAuth>) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({
        name: 'Sign In Test',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    }),
  )
  expect(response.status).toBe(200)
}

function signInRequest(email: string, password: string) {
  return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ email, password }),
  })
}

function getSessionRequest(cookie: string) {
  return new Request(`${BASE_URL}/api/auth/get-session`, {
    method: 'GET',
    headers: { origin: BASE_URL, cookie },
  })
}

describe('sign-in / sign-out HTTP surface', () => {
  it('signs in with the correct password and returns a usable session cookie', async () => {
    const { auth } = makeAuth()
    await signUpTestUser(auth)

    const response = await auth.handler(signInRequest(TEST_EMAIL, TEST_PASSWORD))
    expect(response.status).toBe(200)

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toBeTruthy()

    const sessionResponse = await auth.handler(getSessionRequest(cookie as string))
    expect(sessionResponse.status).toBe(200)
    const session = (await sessionResponse.json()) as { user: { id: string; email: string } }
    expect(session.user).toMatchObject({ email: TEST_EMAIL })
    expect(session.user.id).toBeTruthy()
  })

  it('rejects a wrong password with 401 and sets no session cookie', async () => {
    const { auth } = makeAuth()
    await signUpTestUser(auth)

    const response = await auth.handler(signInRequest(TEST_EMAIL, 'totally-wrong-password'))
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeFalsy()
  })

  it('rejects an unregistered email with the same status as a wrong password (no account enumeration)', async () => {
    const { auth } = makeAuth()
    await signUpTestUser(auth)

    const wrongPassword = await auth.handler(signInRequest(TEST_EMAIL, 'totally-wrong-password'))
    const neverRegistered = await auth.handler(
      signInRequest('never-registered@example.com', 'irrelevant-password'),
    )

    expect(neverRegistered.status).toBe(wrongPassword.status)
    expect(neverRegistered.status).toBe(401)
    expect(neverRegistered.headers.get('set-cookie')).toBeFalsy()
  })

  it('revokes the session server-side on sign-out, not just client-side', async () => {
    const { auth } = makeAuth()
    await signUpTestUser(auth)

    const signInResponse = await auth.handler(signInRequest(TEST_EMAIL, TEST_PASSWORD))
    const cookie = signInResponse.headers.get('set-cookie') as string
    expect(cookie).toBeTruthy()

    // Confirm the session is live before signing out.
    const beforeSignOut = await auth.handler(getSessionRequest(cookie))
    expect(beforeSignOut.status).toBe(200)
    expect(((await beforeSignOut.json()) as { user: unknown } | null)?.user).toBeTruthy()

    const signOutResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin: BASE_URL, cookie },
      }),
    )
    expect(signOutResponse.status).toBe(200)

    // The same old cookie must no longer resolve to a user — the session was
    // revoked server-side, not merely cleared client-side.
    const afterSignOut = await auth.handler(getSessionRequest(cookie))
    expect(afterSignOut.status).toBe(200)
    const afterBody = (await afterSignOut.text()) as string
    expect(afterBody === '' || afterBody === 'null' ? null : JSON.parse(afterBody)).toBeNull()
  })
})
