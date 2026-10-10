import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

/**
 * The request headers Better Auth authenticates, with `cookie` rebuilt from
 * `cookies()` rather than taken from `headers()` as it stands.
 *
 * The two differ in exactly one place, and it matters because the session is
 * cached in a cookie (`session.cookieCache` in `lib/auth/create-auth.ts`).
 * After a Server Action writes a cookie, Next re-renders the route inside the
 * action's own response; in that render `cookies()` reflects the action's
 * writes (`synchronizeMutableCookies` in
 * `node_modules/next/dist/server/async-storage/request-store.js`) but
 * `headers()` is still the ORIGINAL request, cookie header and all ("TODO: does
 * this need to update headers as well?" — same function). So `updateProfile`'s
 * re-render would read the cache cookie from BEFORE the save and paint the old
 * locale, theme, currency and timezone, although the action had just
 * re-issued the cache. Through `cookies()` the session read sees the same
 * cookies as every other read in the render.
 *
 * Values are re-encoded because `cookies()` hands them back decoded and Better
 * Auth decodes again when it parses the header.
 */
async function sessionRequestHeaders(): Promise<Headers> {
  const requestHeaders = new Headers(await headers())
  const cookieStore = await cookies()
  requestHeaders.set(
    'cookie',
    cookieStore
      .getAll()
      .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
      .join('; '),
  )
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
