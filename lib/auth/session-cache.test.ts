import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  cookieHeader,
  makeTestAuth,
  nextTestIp,
  requestPasswordReset,
  resetPassword,
  signIn,
  signOut,
  signUp,
  storeSetCookies,
  type TestAuth,
} from './__testing__/auth-harness'

/**
 * The session cookie cache (`session.cookieCache` in `lib/auth/create-auth.ts`),
 * exercised through the real Better Auth instance on the in-memory adapter —
 * no Postgres, no network, and never `lib/prisma.ts` or `lib/auth/auth.ts`.
 *
 * What it buys: a request carrying a fresh cache cookie authenticates without
 * the session read (and the user read behind it) that otherwise costs two
 * sequential round trips to the production database. What it costs, and the
 * owner accepted on 2026-10-10: a session revoked from elsewhere keeps working
 * from a fresh cache cookie for up to five minutes. These tests pin both halves,
 * and the properties that must NOT move with it: sign-out on the same device
 * ends access at once, a password reset still revokes the database sessions,
 * and the cache cannot be used to set `isDemo`.
 *
 * Cookies travel through `storeSetCookies`/`cookieHeader`, a browser-shaped
 * jar, because the cache only works when BOTH cookies come back — see the
 * harness for why the older tests' raw `set-cookie` echo cannot do that.
 */
const SESSION_TOKEN = 'better-auth.session_token'
const SESSION_DATA = 'better-auth.session_data'
const PASSWORD = 'correct-horse-battery-staple'
const FIVE_MINUTES_MS = 5 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Signs a new user up and then in, and returns the jar sign-in left behind. */
async function signedInJar(auth: TestAuth, email: string, ip: string) {
  await signUp(auth, { email, password: PASSWORD }, { ip })
  const response = await signIn(auth, { email, password: PASSWORD }, { ip })
  expect(response.status).toBe(200)
  return storeSetCookies(new Map(), response.headers)
}

/**
 * Counts the adapter's session lookups from here on. Each one stands for the
 * session + user reads the cache exists to skip (`findSession` in
 * `node_modules/better-auth/dist/db/internal-adapter.mjs` is a `findOne` on
 * `session` joined to `user`).
 */
async function countSessionLookups(auth: TestAuth) {
  const context = await auth.$context
  const findOne = vi.spyOn(context.adapter, 'findOne')
  return () => findOne.mock.calls.filter(([query]) => query.model === 'session').length
}

function readSession(
  auth: TestAuth,
  jar: Map<string, string>,
  query?: { disableCookieCache: boolean },
) {
  return auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }), query })
}

describe('session cookie cache', () => {
  it('issues a five-minute HttpOnly cache cookie at sign-in and serves repeat reads from it', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    const email = 'cache-hit@example.com'
    await signUp(auth, { email, password: PASSWORD }, { ip })
    const response = await signIn(auth, { email, password: PASSWORD }, { ip })
    expect(response.status).toBe(200)

    const cacheCookie = response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_DATA}=`))
    expect(cacheCookie).toBeTruthy()
    const attributes = (cacheCookie as string)
      .split(';')
      .slice(1)
      .map((attribute) => attribute.trim())
    // Max-Age is the owner-approved revocation window; HttpOnly keeps the
    // cached profile (email, preferences) out of reach of page scripts.
    expect(attributes).toEqual(
      expect.arrayContaining(['Max-Age=300', 'HttpOnly', 'SameSite=Lax', 'Path=/']),
    )

    const jar = storeSetCookies(new Map(), response.headers)
    const sessionLookups = await countSessionLookups(auth)

    expect((await readSession(auth, jar))?.user.email).toBe(email)
    expect((await readSession(auth, jar))?.user.email).toBe(email)
    expect(sessionLookups()).toBe(0)
  })

  it('looks the session up once when the cache cookie has lapsed, and re-issues it for the next read', async () => {
    const { auth } = makeTestAuth()
    const email = 'cache-miss@example.com'
    const jar = await signedInJar(auth, email, nextTestIp())
    // What a browser does at Max-Age: the cache cookie is simply gone.
    jar.delete(SESSION_DATA)
    const sessionLookups = await countSessionLookups(auth)

    const first = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(jar) }),
      returnHeaders: true,
    })
    expect(first.response?.user.email).toBe(email)
    storeSetCookies(jar, first.headers)
    expect(jar.has(SESSION_DATA)).toBe(true)

    expect((await readSession(auth, jar))?.user.email).toBe(email)
    expect(sessionLookups()).toBe(1)
  })

  it('rejects a cache cookie edited to claim isDemo, and answers from the database instead', async () => {
    const { auth } = makeTestAuth()
    const jar = await signedInJar(auth, 'cache-tamper@example.com', nextTestIp())

    // The default "compact" encoding is base64url JSON carrying an HMAC of the
    // payload (`setCookieCache` in `node_modules/better-auth/dist/cookies/index.mjs`):
    // readable by whoever holds the cookie, but not editable without the secret.
    const payload = JSON.parse(
      Buffer.from(jar.get(SESSION_DATA) as string, 'base64url').toString('utf8'),
    ) as { session: { user: { isDemo: boolean } } }
    expect(payload.session.user.isDemo).toBe(false)
    payload.session.user.isDemo = true
    jar.set(SESSION_DATA, Buffer.from(JSON.stringify(payload)).toString('base64url'))
    const sessionLookups = await countSessionLookups(auth)

    const session = await readSession(auth, jar)

    expect(session?.user.isDemo).toBe(false)
    expect(sessionLookups()).toBe(1)
  })

  it('sign-out on the same device expires the cache cookie with the session token, so access ends at once', async () => {
    const { auth } = makeTestAuth()
    const ip = nextTestIp()
    const jar = await signedInJar(auth, 'cache-sign-out@example.com', ip)
    expect(jar.has(SESSION_DATA)).toBe(true)
    expect(await readSession(auth, jar)).not.toBeNull()

    const response = await signOut(auth, { ip, cookie: cookieHeader(jar) })
    expect(response.status).toBe(200)
    storeSetCookies(jar, response.headers)

    expect(jar.has(SESSION_TOKEN)).toBe(false)
    expect(jar.has(SESSION_DATA)).toBe(false)
    expect(await readSession(auth, jar)).toBeNull()
  })

  it('a password reset revokes the database sessions; a fresh cache cookie elsewhere outlives it by five minutes at most', async () => {
    // Only `Date` is faked: Better Auth's cache expiry reads `Date.now()`, and
    // leaving timers real keeps the crypto and adapter promises untouched.
    vi.useFakeTimers({ toFake: ['Date'] })
    const { auth, sent } = makeTestAuth()
    const ip = nextTestIp()
    const email = 'cache-revoked@example.com'
    // The "other device": signed in before the reset, holding a fresh cache.
    const jar = await signedInJar(auth, email, ip)

    await requestPasswordReset(auth, { email, redirectTo: '/reset-password' }, { ip })
    // The emailed link is `<base>/api/auth/reset-password/<token>?callbackURL=…`.
    const token = new URL(sent[0].url).pathname.split('/').pop() as string
    const reset = await resetPassword(
      auth,
      { token, newPassword: 'a-brand-new-passphrase-9000' },
      { ip },
    )
    expect(reset.status).toBe(200)

    // `revokeSessionsOnPasswordReset` still deletes the database sessions: a
    // read that bypasses the cache sees the revocation immediately.
    expect(await readSession(auth, jar, { disableCookieCache: true })).toBeNull()
    // The accepted lag: the other device's fresh cache cookie still answers…
    expect((await readSession(auth, jar))?.user.email).toBe(email)
    // …and stops the moment the cache's five minutes are up.
    vi.setSystemTime(Date.now() + FIVE_MINUTES_MS + 1000)
    expect(await readSession(auth, jar)).toBeNull()
  })

  it('a read with disableCookieCache sees a changed user row and re-issues the cache with it', async () => {
    const { auth } = makeTestAuth()
    const jar = await signedInJar(auth, 'cache-refresh@example.com', nextTestIp())
    const userId = (await readSession(auth, jar))?.user.id as string
    const context = await auth.$context
    await context.internalAdapter.updateUser(userId, { locale: 'en' })

    // Until something refreshes it, the cache answers with the row as it was —
    // which is why `updateProfile` refreshes it after its write.
    expect((await readSession(auth, jar))?.user.locale).toBe('vi')

    const refreshed = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(jar) }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    })
    expect(refreshed.response?.user.locale).toBe('en')
    storeSetCookies(jar, refreshed.headers)
    const sessionLookups = await countSessionLookups(auth)

    expect((await readSession(auth, jar))?.user.locale).toBe('en')
    expect(sessionLookups()).toBe(0)
  })
})
