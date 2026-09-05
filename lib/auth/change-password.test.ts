import { describe, it, expect } from 'vitest'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { createAuth } from './create-auth'

/**
 * These tests exercise the real Better Auth change-password flow against an
 * in-memory database, so they need neither Postgres nor the network. They
 * never import `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton) for
 * that reason — same pattern as `lib/auth/sign-in.test.ts` and
 * `lib/auth/reset-password.test.ts`.
 *
 * They pin the HTTP-level behaviour the settings change-password form
 * (Task 7) relies on: a wrong current password is rejected without touching
 * any session, and a correct one rotates the password and — because the form
 * always passes `revokeOtherSessions: true` — revokes every session for the
 * user. Better Auth 1.7.2's implementation revokes ALL sessions unconditionally
 * when `revokeOtherSessions` is set (`internalAdapter.deleteUserSessions`),
 * including the very session that made the request, then creates one brand
 * new session and sets its cookie on the change-password response itself —
 * so the caller's original cookie stops working and the rotated cookie from
 * `set-cookie` is what has to be used afterwards. This file asserts that
 * behaviour exactly rather than assuming the original cookie survives.
 *
 * Task 8 turned on real rate limiting (`lib/auth/create-auth.ts`), which is
 * keyed on `<ip>|<path>` and, with no IP header, falls back to a single
 * shared `127.0.0.1` bucket per path for the whole file (Better Auth's
 * `getIP` fallback in test/dev — see `rate-limit.test.ts` for the citation).
 * Each `it()` below therefore gets its own fake `x-forwarded-for` IP so the
 * handful of sign-in calls one test makes are never mistaken for many
 * requests from one caller and tripped up by the sign-in rate-limit rule.
 */
const BASE_URL = 'http://localhost:3000'
const TEST_SECRET = 'change-password-unit-test-secret-32ch'
const TEST_EMAIL = 'change-password-test@example.com'
const OLD_PASSWORD = 'correct-horse-battery-staple'
const NEW_PASSWORD = 'a-brand-new-passphrase-9000'

let ipCounter = 0
function nextTestIp(): string {
  ipCounter += 1
  return `198.51.100.${100 + ipCounter}`
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

type Auth = ReturnType<typeof createAuth>

async function signUpTestUser(auth: Auth, ip: string) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({
        name: 'Change Password Test',
        email: TEST_EMAIL,
        password: OLD_PASSWORD,
      }),
    }),
  )
  expect(response.status).toBe(200)
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

async function signInAndGetCookie(auth: Auth, ip: string, email: string, password: string) {
  const response = await signIn(auth, ip, email, password)
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toBeTruthy()
  return cookie as string
}

function changePassword(
  auth: Auth,
  ip: string,
  cookie: string,
  body: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean },
) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        'x-forwarded-for': ip,
        cookie,
      },
      body: JSON.stringify(body),
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
 * `get-session` answers 200 with an empty/`null` body once the session is
 * gone, so "no user" is what has to be asserted, not a status code (same
 * helper as `lib/auth/sign-in.test.ts` / `lib/auth/reset-password.test.ts`).
 */
async function sessionUser(auth: Auth, ip: string, cookie: string) {
  const response = await auth.handler(getSessionRequest(ip, cookie))
  expect(response.status).toBe(200)
  const body = await response.text()
  const parsed = body === '' || body === 'null' ? null : (JSON.parse(body) as { user?: unknown })
  return parsed?.user ?? null
}

describe('change-password HTTP surface', () => {
  it('rejects the wrong current password with 400 and rotates nothing', async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    const cookieA = await signInAndGetCookie(auth, ip, TEST_EMAIL, OLD_PASSWORD)

    const response = await changePassword(auth, ip, cookieA, {
      currentPassword: 'totally-wrong-password',
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    })

    // Better Auth 1.7.2 throws `APIError.from('BAD_REQUEST', INVALID_PASSWORD)`
    // for a wrong current password — 400, not 401. Recorded exactly so the
    // form's try/catch is known to be handling the status Better Auth
    // actually returns.
    expect(response.status).toBe(400)
    expect(response.headers.get('set-cookie')).toBeFalsy()

    // Nothing changed: the old password still signs in and the original
    // session is still live.
    expect((await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)).status).toBe(200)
    expect(await sessionUser(auth, ip, cookieA)).toBeTruthy()
  })

  it("changes the password and revokes every session — including the caller's own — rotating its cookie", async () => {
    const { auth } = makeAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    const cookieA = await signInAndGetCookie(auth, ip, TEST_EMAIL, OLD_PASSWORD)
    const cookieB = await signInAndGetCookie(auth, ip, TEST_EMAIL, OLD_PASSWORD)
    expect(await sessionUser(auth, ip, cookieB)).toBeTruthy()

    const response = await changePassword(auth, ip, cookieA, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    })
    expect(response.status).toBe(200)

    const rotatedCookie = response.headers.get('set-cookie')
    expect(rotatedCookie).toBeTruthy()

    // The old password no longer signs in; the new one does.
    expect((await signIn(auth, ip, TEST_EMAIL, OLD_PASSWORD)).status).toBe(401)
    expect((await signIn(auth, ip, TEST_EMAIL, NEW_PASSWORD)).status).toBe(200)

    // Cookie B (the other session) is gone.
    expect(await sessionUser(auth, ip, cookieB)).toBeNull()

    // Cookie A's original value is also gone — `deleteUserSessions` deleted
    // every session for the user, the caller's own included — but the
    // rotated cookie handed back in this response's `set-cookie` header is a
    // live session for the same user.
    expect(await sessionUser(auth, ip, cookieA)).toBeNull()
    const rotatedUser = await sessionUser(auth, ip, rotatedCookie as string)
    expect(rotatedUser).toMatchObject({ email: TEST_EMAIL })
  })
})
