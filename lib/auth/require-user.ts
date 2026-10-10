import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { parseCookie } from 'next/dist/compiled/@edge-runtime/cookies'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

/**
 * The request headers Better Auth authenticates: the request's own `Cookie`
 * header, with the cookies the current Server Action changed laid over it.
 *
 * Not the header as it stands, because the session is cached in a cookie
 * (`session.cookieCache` in `lib/auth/create-auth.ts`). After a Server Action
 * writes a cookie, Next re-renders the route inside the action's own response;
 * in that render `cookies()` reflects the action's writes
 * (`synchronizeMutableCookies` in
 * `node_modules/next/dist/server/async-storage/request-store.js`) but
 * `headers()` is still the ORIGINAL request, cookie header and all ("TODO: does
 * this need to update headers as well?" — same function). So `updateProfile`'s
 * re-render would read the cache cookie from BEFORE the save and paint the old
 * locale, theme, currency and timezone, although the action had just
 * re-issued the cache.
 *
 * Not `cookies()` alone either, because it keeps the LAST copy of a repeated
 * name (`parseCookie` in `node_modules/next/dist/compiled/@edge-runtime/cookies`)
 * while Better Auth reads the session cookies with better-call's
 * `parseCookies`, which keeps the FIRST (`node_modules/better-call/dist/cookies.mjs`).
 * A name repeats when another host under the parent domain plants a
 * `__Secure-` session cookie with `Domain=`, copied from the planter's own
 * account; browsers send the older cookie — the user's own — first, so
 * last-wins would hand the request to the planted account.
 *
 * So a cookie whose `cookies()` value differs from Next's own parse of the raw
 * header, or is missing from it, is one the action wrote. It goes first and
 * its raw copies are dropped, so both of Better Auth's readers see the action's
 * value: better-call's first-wins parse and Better Auth's own last-wins
 * `parseCookies`, which reassembles chunked cookies
 * (`node_modules/better-auth/dist/cookies/session-store.mjs`). An empty value
 * is a deletion — `cookies().delete()` stores one, and Better Auth's
 * `Max-Age=0` expiry reaches `cookies().set` as one through `nextCookies()` —
 * so that name is dropped entirely rather than resurrected from the raw
 * header. Every other pair stays as the browser sent it, in its order; outside
 * a Server Action nothing differs and the header goes through untouched. (A
 * write equal to the raw header's last copy of a repeated name looks
 * unchanged, and Better Auth then sees what it saw before the action.)
 *
 * Written values are re-encoded because `cookies()` hands them back decoded
 * and Better Auth decodes again when it parses the header.
 */
async function sessionRequestHeaders(): Promise<Headers> {
  const requestHeaders = new Headers(await headers())
  const sent = requestHeaders.get('cookie') ?? ''
  const asSent = parseCookie(sent)
  const changed = new Set<string>()
  const written: string[] = []
  for (const { name, value } of (await cookies()).getAll()) {
    if (asSent.get(name) === value) continue
    changed.add(name)
    if (value !== '') written.push(`${name}=${encodeURIComponent(value)}`)
  }
  if (changed.size === 0) return requestHeaders
  const untouched = sent
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !changed.has(pair.split('=', 1)[0].trim()))
  requestHeaders.set('cookie', [...written, ...untouched].join('; '))
  return requestHeaders
}

/**
 * Resolves the current session, or `null`.
 *
 * Wrapped in React's `cache()` so a layout and every page/component that asks
 * within the same request share one session lookup instead of hitting the
 * database once per caller — Phase 2 onwards will have many callers per render.
 * The memo is scoped to the React request, so two different requests never see
 * each other's session.
 *
 * Outside a React request (Vitest, a script) `cache()` is a transparent
 * pass-through — the client build's `cache` simply applies the function
 * (`node_modules/react/cjs/react.development.js`), and the react-server build
 * falls back to the same when there is no dispatcher
 * (`node_modules/react/cjs/react.react-server.development.js`). No memo means
 * no leakage between tests, so `require-user.test.ts` stays deterministic
 * without any reset hook.
 */
export const getOptionalSession = cache(async () => {
  return auth.api.getSession({ headers: await sessionRequestHeaders() })
})

/**
 * Re-reads the session from the database, bypassing the cookie cache, so
 * Better Auth re-issues the cache cookie with the current row.
 *
 * For a Server Action that has just changed a field the cache carries — that
 * is `updateProfile`. Without it both the action's own re-render and every
 * request for up to the cache's five minutes would still see the old values.
 * `nextCookies()` (`lib/auth/create-auth.ts`) is what lands the re-issued
 * cookie in the action's response, and `sessionRequestHeaders` above is what
 * lets that same response's re-render read it.
 */
export async function refreshSessionCache(): Promise<void> {
  await auth.api.getSession({
    headers: await sessionRequestHeaders(),
    query: { disableCookieCache: true },
  })
}

/**
 * The session user, or a thrown `UnauthorizedError`. This is the guard for
 * services and server actions, where "not authenticated" is a programming
 * error the caller must not proceed past — every query in every phase is
 * scoped by the id it returns.
 */
export async function requireUser() {
  const session = await getOptionalSession()
  if (!session?.user) throw new UnauthorizedError()
  return session.user
}

/**
 * The session user, or a redirect to `/login`. This is the guard for pages.
 *
 * A layout is NOT an auth boundary: Next renders a layout and its page
 * concurrently, and a client-side navigation can re-render the page without
 * re-running the layout. Every `(app)` page therefore calls this itself. It
 * redirects rather than throwing because for a page "not signed in" is an
 * ordinary state with a correct answer (the login screen), not an error worth
 * a stack trace.
 */
export async function requireUserOrRedirect() {
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  return session.user
}
