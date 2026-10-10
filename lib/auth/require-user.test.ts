import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { parseCookies as parseFirstWins } from 'better-call'
import {
  parseCookies as parseLastWins,
  parseSetCookieHeader,
  toCookieOptions,
} from 'better-auth/cookies'
import { RequestCookies, type ResponseCookies } from 'next/dist/compiled/@edge-runtime/cookies'
import {
  MutableRequestCookiesAdapter,
  RequestCookiesAdapter,
  responseCookiesToRequestCookies,
} from 'next/dist/server/web/spec-extension/adapters/request-cookies'
import { cookieHeader, storeSetCookies } from './__testing__/auth-harness'

/**
 * These tests never touch Postgres or the network: `@/lib/auth/auth` (the app
 * singleton, which wires up the Prisma adapter) is mocked out entirely so that
 * `lib/prisma.ts` is never imported, and `next/headers` is mocked so each test
 * controls exactly which request headers and cookies
 * `requireUser()`/`getOptionalSession()` see. The mocked auth instance is a
 * real Better Auth instance built by `createAuth` against the in-memory
 * adapter — same pattern as `lib/auth/create-auth.test.ts` — so signing up
 * through it produces a real session cookie.
 */
const headersMock = vi.hoisted(() => vi.fn())
const cookiesMock = vi.hoisted(() => vi.fn())

vi.mock('next/headers', () => ({
  headers: headersMock,
  cookies: cookiesMock,
}))

beforeEach(() => {
  // By default `cookies()` is the request's own `Cookie` header, parsed by the
  // class Next itself uses — which is what every render that does not follow a
  // Server Action sees. The tests about a Server Action's request override it.
  cookiesMock.mockImplementation(async () => new RequestCookies(await headersMock()))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * `redirect()` works by throwing a control-flow error Next catches while
 * rendering; outside a render there is nothing to catch it. The stand-in throws
 * a recognisable marker so a test can assert both that the redirect happened
 * and that it targeted `/login`, and so `requireUserOrRedirect()` never falls
 * through to returning `undefined`.
 */
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
)

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}))

vi.mock('@/lib/auth/auth', async () => {
  // The dynamic import here (rather than a top-level import of this file) is
  // required by Vitest's mock hoisting: this factory runs before this file's
  // own top-level statements, including any `import` bindings.
  const { makeTestAuth } = await import('./__testing__/auth-harness')
  return { auth: makeTestAuth().auth }
})

const { auth } = await import('@/lib/auth/auth')
const {
  requireUser,
  requireUserOrRedirect,
  getOptionalSession,
  refreshSessionCache,
  UnauthorizedError,
} = await import('./require-user')

describe('getOptionalSession', () => {
  it('returns null when there is no cookie', async () => {
    headersMock.mockResolvedValue(new Headers())

    expect(await getOptionalSession()).toBeNull()
  })

  it('reads the session cookies through cookies(), so the render after a Server Action sees the cache cookie the action rewrote', async () => {
    const { headers: signUpHeaders, response } = await auth.api.signUpEmail({
      body: {
        name: 'Vo Thi F',
        email: 'vo@example.com',
        password: 'correct-horse-battery-staple',
      },
      returnHeaders: true,
    })
    // Token + a cache cookie holding the row as it was: locale `vi`.
    const beforeAction = storeSetCookies(new Map(), signUpHeaders)
    expect(beforeAction.has('better-auth.session_data')).toBe(true)

    // What `updateProfile` does: write the row, then re-read the session past
    // the cache, which re-issues the cache cookie with the new values.
    const context = await auth.$context
    await context.internalAdapter.updateUser(response.user.id, { locale: 'en' })
    const refreshed = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(beforeAction) }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    })
    const afterAction = storeSetCookies(new Map(beforeAction), refreshed.headers)

    // The render Next runs inside the action's response: `headers()` is still
    // the ORIGINAL request, old cache cookie included, while `cookies()`
    // reflects the action's writes (`synchronizeMutableCookies` in
    // `node_modules/next/dist/server/async-storage/request-store.js`).
    headersMock.mockResolvedValue(new Headers({ cookie: cookieHeader(beforeAction) }))
    cookiesMock.mockResolvedValue(
      new RequestCookies(new Headers({ cookie: cookieHeader(afterAction) })),
    )

    const session = await getOptionalSession()

    expect(session?.user.locale).toBe('en')
  })
})

let browsers = 0

/** Signs a fresh user up: their id, and the cookies a browser now holds. */
async function signedUpBrowser(name: string) {
  browsers += 1
  const { headers, response } = await auth.api.signUpEmail({
    body: {
      name,
      email: `precedence-${browsers}@example.com`,
      password: 'correct-horse-battery-staple',
    },
    returnHeaders: true,
  })
  return { userId: response.user.id, jar: storeSetCookies(new Map(), headers), setCookies: headers }
}

/**
 * Writes Better Auth's `Set-Cookie` lines into `cookies()` exactly as the
 * `nextCookies()` plugin does inside a Server Action (its after-hook in
 * `node_modules/better-auth/dist/integrations/next-js.mjs`) — including an
 * expiry, which arrives as an empty value with `Max-Age=0`.
 */
function writeLikeNextCookies(store: ResponseCookies, setCookies: Headers) {
  parseSetCookieHeader(setCookies.get('set-cookie') ?? '').forEach((attributes, name) => {
    store.set(name, attributes.value, toCookieOptions(attributes))
  })
}

const PHASES = ['during the action', 'in the re-render after it'] as const
type Phase = (typeof PHASES)[number]

/**
 * Serves `getOptionalSession` the request of a Server Action that sent
 * `requestCookie` and made the writes in `act`, built from Next's own classes.
 * During the action `cookies()` is the mutable store seeded from the request
 * header (`getMutableCookies` in
 * `node_modules/next/dist/server/async-storage/request-store.js`); in the
 * re-render inside its response it is the read-only copy
 * `synchronizeMutableCookies` makes of that store. `headers()` is the original
 * request in both.
 */
async function serveAction(
  requestCookie: string,
  phase: Phase,
  act: (store: ResponseCookies) => void | Promise<void>,
) {
  const store = MutableRequestCookiesAdapter.wrap(
    new RequestCookies(new Headers({ cookie: requestCookie })),
  )
  await act(store)
  headersMock.mockResolvedValue(new Headers({ cookie: requestCookie }))
  cookiesMock.mockResolvedValue(
    phase === 'during the action'
      ? store
      : RequestCookiesAdapter.seal(responseCookiesToRequestCookies(store)),
  )
}

/** The `Cookie` header the latest `auth.api.getSession` call was handed. */
function sentCookieHeader(getSession: MockInstance): string {
  const [call] = getSession.mock.lastCall as [{ headers: Headers }]
  return call.headers.get('cookie') ?? ''
}

/** An action write that touches no session cookie. */
const writePreference = (store: ResponseCookies) => {
  store.set('NEXT_LOCALE', 'en')
}

/**
 * A browser sends a name twice when two cookies share it with a different
 * Domain or Path — e.g. a `__Secure-better-auth.session_token` planted for the
 * parent domain by another host under it, copied from the planter's own
 * account. Better Auth reads the session cookies with better-call's
 * `parseCookies`, which keeps the FIRST copy
 * (`node_modules/better-call/dist/cookies.mjs`), and a browser sends the older
 * cookie — the user's own — first, while Next's `cookies()` keeps the LAST.
 * So the first copy in the raw header must be what Better Auth sees, whatever
 * else the request did. Both orderings are tested: first-wins, not a
 * preference for either account.
 */
const REPEATED_NAME_CONTEXTS: [string, (requestCookie: string) => Promise<void>][] = [
  [
    'in a render no action ran in',
    async (requestCookie) => {
      headersMock.mockResolvedValue(new Headers({ cookie: requestCookie }))
    },
  ],
  [
    'during an action that wrote only a preference cookie',
    (requestCookie) => serveAction(requestCookie, 'during the action', writePreference),
  ],
  [
    'in the re-render after that action',
    (requestCookie) => serveAction(requestCookie, 'in the re-render after it', writePreference),
  ],
]

describe.each(REPEATED_NAME_CONTEXTS)('a repeated session cookie name, %s', (_, serve) => {
  it('the user’s own cookies, sent first, win over a planted copy sent after them', async () => {
    const own = await signedUpBrowser('Nguyen Thi H')
    const planted = await signedUpBrowser('Planter')
    await serve(`${cookieHeader(own.jar)}; ${cookieHeader(planted.jar)}`)

    expect((await getOptionalSession())?.user.id).toBe(own.userId)
  })

  it('in the opposite order the first copy still wins', async () => {
    const own = await signedUpBrowser('Nguyen Thi H')
    const planted = await signedUpBrowser('Planter')
    await serve(`${cookieHeader(planted.jar)}; ${cookieHeader(own.jar)}`)

    expect((await getOptionalSession())?.user.id).toBe(planted.userId)
  })
})

describe.each(PHASES)('cookies the action wrote, %s', (phase) => {
  it('a re-issued cache cookie and a preference cookie win over the request’s copies', async () => {
    const user = await signedUpBrowser('Vo Thi F')
    const context = await auth.$context
    await context.internalAdapter.updateUser(user.userId, { locale: 'en' })
    const refreshed = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(user.jar) }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    })
    const reissued = parseSetCookieHeader(refreshed.headers.get('set-cookie') ?? '').get(
      'better-auth.session_data',
    )?.value
    expect(reissued).toBeTruthy()
    await serveAction(`${cookieHeader(user.jar)}; NEXT_LOCALE=vi`, phase, (store) => {
      writeLikeNextCookies(store, refreshed.headers)
      store.set('NEXT_LOCALE', 'en')
    })
    const getSession = vi.spyOn(auth.api, 'getSession')

    const session = await getOptionalSession()

    expect(session?.user.locale).toBe('en')
    // Both of Better Auth's readers see the action's values: better-call's
    // first-wins parse (session token, cache cookie) and Better Auth's own
    // last-wins `parseCookies` (chunked cookies, in
    // `node_modules/better-auth/dist/cookies/session-store.mjs`).
    for (const parse of [parseFirstWins, parseLastWins]) {
      const sent = parse(sentCookieHeader(getSession))
      expect(sent.get('better-auth.session_data')).toBe(reissued)
      expect(sent.get('NEXT_LOCALE')).toBe('en')
    }
  })

  it('a session token the action wrote wins over the request’s token', async () => {
    const before = await signedUpBrowser('Tran Van I')
    const after = await signedUpBrowser('Tran Van K')
    await serveAction(cookieHeader(before.jar), phase, (store) =>
      writeLikeNextCookies(store, after.setCookies),
    )

    expect((await getOptionalSession())?.user.id).toBe(after.userId)
  })
})

describe.each(PHASES)('cookies the action deleted, %s', (phase) => {
  const deletions: [string, (store: ResponseCookies, requestCookie: string) => Promise<void>][] = [
    [
      'with cookies().delete',
      async (store) => {
        store.delete('better-auth.session_token')
        store.delete('better-auth.session_data')
      },
    ],
    [
      'with Better Auth’s expiring Set-Cookie, through nextCookies()',
      async (store, requestCookie) => {
        const signedOut = await auth.api.signOut({
          headers: new Headers({ cookie: requestCookie }),
          returnHeaders: true,
        })
        writeLikeNextCookies(store, signedOut.headers)
      },
    ],
  ]

  it.each(deletions)(
    'are not passed through from the request, %s — every copy of the name stays gone',
    async (_, del) => {
      const own = await signedUpBrowser('Le Van G')
      const planted = await signedUpBrowser('Planter')
      const requestCookie = `${cookieHeader(own.jar)}; ${cookieHeader(planted.jar)}`
      await serveAction(requestCookie, phase, (store) => del(store, requestCookie))
      const getSession = vi.spyOn(auth.api, 'getSession')

      expect(await getOptionalSession()).toBeNull()
      for (const parse of [parseFirstWins, parseLastWins]) {
        const sent = parse(sentCookieHeader(getSession))
        expect(sent.get('better-auth.session_token') ?? '').toBe('')
        expect(sent.get('better-auth.session_data') ?? '').toBe('')
      }
    },
  )
})

describe('refreshSessionCache', () => {
  it('re-reads the session past the cookie cache, with the request’s cookies', async () => {
    const getSession = vi.spyOn(auth.api, 'getSession')
    headersMock.mockResolvedValue(new Headers({ cookie: 'better-auth.session_token=abc' }))

    await refreshSessionCache()

    expect(getSession).toHaveBeenCalledTimes(1)
    const [call] = getSession.mock.calls[0] as [{ headers: Headers; query: unknown }]
    expect(call.query).toEqual({ disableCookieCache: true })
    expect(call.headers.get('cookie')).toBe('better-auth.session_token=abc')
  })
})

describe('requireUser', () => {
  it('throws UnauthorizedError when there is no cookie', async () => {
    headersMock.mockResolvedValue(new Headers())

    let error: unknown
    try {
      await requireUser()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect((error as Error).name).toBe('UnauthorizedError')
  })

  it('resolves to the signed-up user identified by their session cookie', async () => {
    const { headers: signUpHeaders, response } = await auth.api.signUpEmail({
      body: {
        name: 'Pham Thi D',
        email: 'pham@example.com',
        password: 'correct-horse-battery-staple',
      },
      returnHeaders: true,
    })
    const setCookie = signUpHeaders.get('set-cookie')
    expect(setCookie).toBeTruthy()

    headersMock.mockResolvedValue(new Headers({ cookie: setCookie as string }))

    const user = await requireUser()

    // The identity comes from the session, never from any input we pass here.
    expect(user.id).toBe(response.user.id)
    expect(user.email).toBe('pham@example.com')
  })
})

describe('requireUserOrRedirect', () => {
  it('redirects to /login when there is no cookie instead of throwing UnauthorizedError', async () => {
    headersMock.mockResolvedValue(new Headers())
    redirectMock.mockClear()

    let error: unknown
    try {
      await requireUserOrRedirect()
    } catch (caught) {
      error = caught
    }

    expect(redirectMock).toHaveBeenCalledWith('/login')
    expect((error as Error).message).toBe('NEXT_REDIRECT:/login')
    // A page must not produce an UnauthorizedError stack for an ordinary
    // logged-out visit — that is what this function exists to avoid.
    expect(error).not.toBeInstanceOf(UnauthorizedError)
  })

  it('resolves to the signed-up user identified by their session cookie', async () => {
    const { headers: signUpHeaders, response } = await auth.api.signUpEmail({
      body: {
        name: 'Hoang Van E',
        email: 'hoang@example.com',
        password: 'correct-horse-battery-staple',
      },
      returnHeaders: true,
    })
    const setCookie = signUpHeaders.get('set-cookie')
    expect(setCookie).toBeTruthy()

    headersMock.mockResolvedValue(new Headers({ cookie: setCookie as string }))
    redirectMock.mockClear()

    const user = await requireUserOrRedirect()

    expect(redirectMock).not.toHaveBeenCalled()
    expect(user.id).toBe(response.user.id)
    expect(user.email).toBe('hoang@example.com')
  })
})
