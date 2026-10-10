import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies'
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
  // Server Action sees. The one test about the post-action render overrides it.
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
