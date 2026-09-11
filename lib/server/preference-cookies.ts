import { headers } from 'next/headers'

/**
 * The two preference mirror cookies (`NEXT_LOCALE`, `cashflow-theme`) are
 * written from two places — `lib/server/actions/update-profile.ts` when the
 * user saves Settings, and `lib/server/actions/sync-preference-cookies.ts`
 * right after a sign-in. This module is the single definition of the
 * attributes they get, so the two call sites cannot drift.
 */

/** One year, unchanged from the original call sites. */
export const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export interface PreferenceCookieOptions {
  path: '/'
  sameSite: 'lax'
  maxAge: number
  secure: boolean
}

/**
 * Whether the cookies written for THIS request should carry `Secure`.
 *
 * The decision source deliberately mirrors Better Auth's own, which is what
 * already decides whether the session cookie gets the `__Secure-` prefix
 * (`node_modules/better-auth/dist/cookies/index.mjs`: the dynamic request
 * protocol first, then the configured base URL, then `isProduction`). Keeping
 * one rule means a deployment cannot end up with a `Secure` session cookie and
 * a plain preference cookie, or the reverse.
 *
 * Two inputs, OR'd:
 *
 * - `x-forwarded-proto` says `https` — the reverse proxy in front of this app
 *   terminated TLS (`next start` also sets this header itself from the
 *   connection, so a direct HTTPS listener is covered too).
 * - `NODE_ENV === 'production'` — a production process is expected to be
 *   served over HTTPS whatever the header says, so it fails closed if a proxy
 *   forwards nothing.
 *
 * `localhost` HTTP development therefore gets plain cookies and keeps working;
 * a `Secure` cookie would simply be dropped by the browser there, silently
 * losing the user's theme and language.
 *
 * The header is client-forgeable when no proxy overwrites it — which is
 * harmless here, because the only thing a forged value can do is turn `Secure`
 * ON for the forger's own preference cookies. There is no input that turns it
 * off in production.
 *
 * Not `httpOnly`, as before: both values are presentation preferences with
 * nothing to protect, and `app/global-error.tsx` reads them from
 * `document.cookie` to paint its fallback screen.
 */
export function isSecureRequest(
  headerList: Pick<Headers, 'get'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const forwardedProto = headerList.get('x-forwarded-proto')
  // A proxy chain appends, so the left-most entry is the one the client spoke.
  const clientProto = forwardedProto?.split(',')[0]?.trim().toLowerCase()
  if (clientProto === 'https') return true
  return env.NODE_ENV === 'production'
}

/** The attribute set for both preference cookies on the current request. */
export async function preferenceCookieOptions(): Promise<PreferenceCookieOptions> {
  const headerList = await headers()
  return {
    path: '/',
    sameSite: 'lax',
    maxAge: PREFERENCE_COOKIE_MAX_AGE,
    secure: isSecureRequest(headerList),
  }
}
