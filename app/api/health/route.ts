import { prisma } from '@/lib/prisma'
import { log } from '@/lib/server/log'

/**
 * `GET /api/health` — the platform probe (phase 8, E5).
 *
 * A container that boots but cannot reach Postgres is useless, and without this
 * endpoint a platform has nothing to call: `/` redirects and `/login` renders a
 * cookie-reading React page. Neither distinguishes "process alive" from
 * "database gone".
 *
 * The contract is deliberately tiny:
 *
 * - `200 {"status":"ok"}` when a `SELECT 1` returns within
 *   {@link PROBE_TIMEOUT_MS}; `503 {"status":"unavailable"}` when it rejects,
 *   times out, or the Prisma client cannot even be constructed.
 * - Exactly one key. No version, build id, hostname, database name, migration
 *   state, duration or driver error text. This is an unauthenticated endpoint
 *   on a finance app, and everything it reveals is free fingerprinting for an
 *   attacker; the failure detail goes to the server log instead, where it is
 *   redacted by `lib/server/log.ts` (a Prisma initialisation error quotes the
 *   connection string).
 * - `Cache-Control: no-store`, so a proxy can never answer a probe from cache
 *   and report a dead process as healthy.
 * - No `requireUser`: a probe has no session. Nothing here reads user data, so
 *   the tenant-isolation rule is not in play.
 *
 * `force-dynamic` because the answer is a live measurement; without it Next
 * would be free to treat the handler as static.
 *
 * The response headers from `next.config.ts` apply here too — the header rule
 * matches `/(.*)`.
 */

export const dynamic = 'force-dynamic'

/**
 * The bound on the database round trip. Long enough that a briefly busy
 * database is not called dead, short enough that a probe with a typical 5 s
 * interval never overlaps itself.
 */
export const PROBE_TIMEOUT_MS = 2_000

/** The one thing this endpoint measures. Injected so the tests need no database. */
export type HealthProbe = () => Promise<unknown>

const databaseProbe: HealthProbe = () => prisma.$queryRaw`SELECT 1`

function healthResponse(ok: boolean): Response {
  return Response.json(
    { status: ok ? 'ok' : 'unavailable' },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * The handler's whole body, with the probe and its bound injectable.
 *
 * `Promise.race` rather than an `AbortSignal`: the pg driver does not cancel an
 * in-flight statement on abort anyway, and what the probe must guarantee is a
 * bounded *answer*, not a cancelled query. The timer is always cleared, so a
 * fast success never holds the event loop open for two seconds.
 */
export async function checkHealth(
  probe: HealthProbe = databaseProbe,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMED_OUT = Symbol('timed-out')
  try {
    const outcome = await Promise.race([
      probe(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      }),
    ])
    if (outcome === TIMED_OUT) {
      log.warn('health.probe_timeout', { timeoutMs })
      return healthResponse(false)
    }
    return healthResponse(true)
  } catch (error) {
    log.warn('health.probe_failed', { error })
    return healthResponse(false)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function GET(): Promise<Response> {
  return checkHealth()
}
