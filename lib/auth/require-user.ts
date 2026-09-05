import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
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
  return auth.api.getSession({ headers: await headers() })
})

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
