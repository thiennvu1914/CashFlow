import { describe, it, expect } from 'vitest'
import {
  makeTestAuth,
  nextTestIp,
  signUp,
  signIn,
  signOut,
  getSession,
  sessionUser,
} from './__testing__/auth-harness'

/**
 * These tests exercise the real Better Auth instance against an in-memory
 * database, so they need neither Postgres nor the network. They never import
 * `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton) for that reason —
 * see `lib/auth/__testing__/auth-harness.ts`, which also explains why every
 * request carries its own fake `x-forwarded-for` IP.
 *
 * They pin the HTTP-level sign-in / sign-out behaviour the login and logout
 * UI (Task 4) relies on: a correct-password sign-in issues a session cookie,
 * a wrong password and an unregistered email both fail the same way (no
 * account-enumeration via status code), and sign-out revokes the session
 * server-side rather than merely asking the browser to drop the cookie.
 */
const TEST_EMAIL = 'sign-in-test@example.com'
const TEST_PASSWORD = 'correct-horse-battery-staple'

describe('sign-in / sign-out HTTP surface', () => {
  it('signs in with the correct password and returns a usable session cookie', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUp(auth, { name: 'Sign In Test', email: TEST_EMAIL, password: TEST_PASSWORD }, { ip })

    const response = await signIn(auth, { email: TEST_EMAIL, password: TEST_PASSWORD }, { ip })
    expect(response.status).toBe(200)

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toBeTruthy()

    const sessionResponse = await getSession(auth, { ip, cookie: cookie as string })
    expect(sessionResponse.status).toBe(200)
    const session = (await sessionResponse.json()) as { user: { id: string; email: string } }
    expect(session.user).toMatchObject({ email: TEST_EMAIL })
    expect(session.user.id).toBeTruthy()
  })

  it('rejects a wrong password with 401 and sets no session cookie', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUp(auth, { name: 'Sign In Test', email: TEST_EMAIL, password: TEST_PASSWORD }, { ip })

    const response = await signIn(
      auth,
      { email: TEST_EMAIL, password: 'totally-wrong-password' },
      { ip },
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeFalsy()
  })

  it('rejects an unregistered email with the same status as a wrong password (no account enumeration)', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUp(auth, { name: 'Sign In Test', email: TEST_EMAIL, password: TEST_PASSWORD }, { ip })

    const wrongPassword = await signIn(
      auth,
      { email: TEST_EMAIL, password: 'totally-wrong-password' },
      { ip },
    )
    const neverRegistered = await signIn(
      auth,
      { email: 'never-registered@example.com', password: 'irrelevant-password' },
      { ip },
    )

    expect(neverRegistered.status).toBe(wrongPassword.status)
    expect(neverRegistered.status).toBe(401)
    expect(neverRegistered.headers.get('set-cookie')).toBeFalsy()
  })

  it('revokes the session server-side on sign-out, not just client-side', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUp(auth, { name: 'Sign In Test', email: TEST_EMAIL, password: TEST_PASSWORD }, { ip })

    const signInResponse = await signIn(
      auth,
      { email: TEST_EMAIL, password: TEST_PASSWORD },
      { ip },
    )
    const cookie = signInResponse.headers.get('set-cookie') as string
    expect(cookie).toBeTruthy()

    // Confirm the session is live before signing out.
    expect(await sessionUser(auth, { ip, cookie })).toBeTruthy()

    const signOutResponse = await signOut(auth, { ip, cookie })
    expect(signOutResponse.status).toBe(200)

    // The same old cookie must no longer resolve to a user — the session was
    // revoked server-side, not merely cleared client-side.
    expect(await sessionUser(auth, { ip, cookie })).toBeNull()
  })
})
