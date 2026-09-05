import { describe, it, expect } from 'vitest'
import {
  makeTestAuth,
  nextTestIp,
  signUp,
  signIn,
  signInAndGetCookie,
  sessionUser,
  changePassword,
  type TestAuth,
} from './__testing__/auth-harness'

/**
 * These tests exercise the real Better Auth change-password flow against an
 * in-memory database, so they need neither Postgres nor the network. They
 * never import `lib/prisma.ts` or `lib/auth/auth.ts` (the app singleton) for
 * that reason — see `lib/auth/__testing__/auth-harness.ts`, which also explains
 * why every request carries its own fake `x-forwarded-for` IP.
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
 */
const TEST_EMAIL = 'change-password-test@example.com'
const OLD_PASSWORD = 'correct-horse-battery-staple'
const NEW_PASSWORD = 'a-brand-new-passphrase-9000'

function signUpTestUser(auth: TestAuth, ip: string) {
  return signUp(
    auth,
    { name: 'Change Password Test', email: TEST_EMAIL, password: OLD_PASSWORD },
    { ip },
  )
}

describe('change-password HTTP surface', () => {
  it('rejects the wrong current password with 400 and rotates nothing', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    const cookieA = await signInAndGetCookie(
      auth,
      { email: TEST_EMAIL, password: OLD_PASSWORD },
      { ip },
    )

    const response = await changePassword(
      auth,
      {
        currentPassword: 'totally-wrong-password',
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      },
      { ip, cookie: cookieA },
    )

    // Better Auth 1.7.2 throws `APIError.from('BAD_REQUEST', INVALID_PASSWORD)`
    // for a wrong current password — 400, not 401. Recorded exactly so the
    // form's try/catch is known to be handling the status Better Auth
    // actually returns.
    expect(response.status).toBe(400)
    expect(response.headers.get('set-cookie')).toBeFalsy()

    // Nothing changed: the old password still signs in and the original
    // session is still live.
    expect((await signIn(auth, { email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })).status).toBe(
      200,
    )
    expect(await sessionUser(auth, { ip, cookie: cookieA })).toBeTruthy()
  })

  it("changes the password and revokes every session — including the caller's own — rotating its cookie", async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    await signUpTestUser(auth, ip)
    const cookieA = await signInAndGetCookie(
      auth,
      { email: TEST_EMAIL, password: OLD_PASSWORD },
      { ip },
    )
    const cookieB = await signInAndGetCookie(
      auth,
      { email: TEST_EMAIL, password: OLD_PASSWORD },
      { ip },
    )
    expect(await sessionUser(auth, { ip, cookie: cookieB })).toBeTruthy()

    const response = await changePassword(
      auth,
      {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      },
      { ip, cookie: cookieA },
    )
    expect(response.status).toBe(200)

    const rotatedCookie = response.headers.get('set-cookie')
    expect(rotatedCookie).toBeTruthy()

    // The old password no longer signs in; the new one does.
    expect((await signIn(auth, { email: TEST_EMAIL, password: OLD_PASSWORD }, { ip })).status).toBe(
      401,
    )
    expect((await signIn(auth, { email: TEST_EMAIL, password: NEW_PASSWORD }, { ip })).status).toBe(
      200,
    )

    // Cookie B (the other session) is gone.
    expect(await sessionUser(auth, { ip, cookie: cookieB })).toBeNull()

    // Cookie A's original value is also gone — `deleteUserSessions` deleted
    // every session for the user, the caller's own included — but the
    // rotated cookie handed back in this response's `set-cookie` header is a
    // live session for the same user.
    expect(await sessionUser(auth, { ip, cookie: cookieA })).toBeNull()
    const rotatedUser = await sessionUser(auth, { ip, cookie: rotatedCookie as string })
    expect(rotatedUser).toMatchObject({ email: TEST_EMAIL })
  })
})
