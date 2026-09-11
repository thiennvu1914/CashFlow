import type { Instrumentation } from 'next'
import { log } from '@/lib/server/log'

/**
 * Server instrumentation (phase 8, A-2/A-4).
 *
 * Next calls `onRequestError` whenever the server captures an error from a
 * render, a route handler or a server action. Until now such a failure left no
 * server-side record at all that could be tied to what the user saw: the error
 * boundaries (`app/(app)/error.tsx`, `app/global-error.tsx`) show
 * `error.digest` as a reference code, and nothing wrote that digest down. This
 * file is the other half of that pair — the user reads a code out loud and the
 * operator greps `request.error` for it.
 *
 * What is logged is deliberately narrow: the digest, the HTTP method, the
 * request *pathname* and the router/route kind. Never the query string (it
 * carries report ranges, ids and, on any future link, a token), never headers
 * (cookies, `Authorization`), never the body, never a user id. The error itself
 * is serialised by `lib/server/log.ts` to `{ name, message, digest }` with no
 * stack and with any embedded credentials masked.
 *
 * No monitoring platform and no transport: this writes one line to stdout,
 * which is what every deployment target already collects.
 */

/** Everything after `?` or `#` is dropped; only the path survives. */
function pathnameOf(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined
  // `request.path` is documented as a resource path such as `/blog?name=foo`,
  // so it may be relative; a base makes it parseable either way, and a value
  // that is not a URL at all falls back to a manual cut rather than throwing
  // inside an error handler.
  try {
    return new URL(path, 'http://localhost').pathname
  } catch {
    return path.split(/[?#]/)[0]
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function digestOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return undefined
  return stringOrUndefined((error as { digest?: unknown }).digest)
}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  log.error('request.error', {
    // The same value the user is shown as a reference code.
    digest: digestOf(error),
    method: stringOrUndefined((request as { method?: unknown }).method),
    path: pathnameOf((request as { path?: unknown }).path),
    routerKind: stringOrUndefined((context as { routerKind?: unknown }).routerKind),
    routeType: stringOrUndefined((context as { routeType?: unknown }).routeType),
    error,
  })
}

/**
 * Runs once per server instance, before the first request. One startup line and
 * nothing else — no agent, no exporter, no side effect a boot could fail on.
 */
export function register(): void {
  log.info('server.start', { runtime: process.env.NEXT_RUNTIME ?? 'nodejs' })
}
