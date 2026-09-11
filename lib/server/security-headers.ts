/**
 * The response headers applied to every route (`next.config.ts`'s
 * `headers()` matches `/(.*)`, so this list reaches API routes — including
 * the `/api/health` endpoint Task 11 adds later — the same as every page).
 *
 * Exported from a plain module (no Next-specific types) so a Vitest test can
 * assert the exact set in both `development` and `production` without
 * importing `next.config.ts` itself (`NextConfig#headers()` is async and
 * typed against Next's build pipeline, which is awkward to unit test
 * directly; `next.config.ts` just calls this function and returns its
 * result).
 *
 * `Strict-Transport-Security` is production-only: TLS terminates at the
 * platform's proxy in every deploy target this app runs on (Railway/Render/
 * Fly — see `docs/operations.md`), so the header would be a lie in local dev
 * over plain HTTP, and browsers ignore it there anyway. "Production-only"
 * means the environment of the machine that ran `next build` — see
 * `securityHeadersFor` below. `includeSubDomains`
 * is set; `preload` is deliberately withheld — that is effectively a
 * one-way, browser-vendor-list commitment the owner has not made.
 *
 * The CSP here is `frame-ancestors 'none'` ONLY. A `script-src`/nonce CSP
 * needs a per-request nonce threaded through middleware, which is out of
 * scope for Phase 8 (see the Wave 2 plan's Task 10 entry and preflight
 * evidence C2/E7) — `X-Frame-Options: DENY` plus this directive is the
 * non-nonce clickjacking defence for both legacy and modern browsers.
 */
export function isProductionMode(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production'
}

export interface SecurityHeader {
  key: string
  value: string
}

/**
 * Headers shipped in every environment, including local `next dev` — none of
 * them depend on TLS being present.
 */
export const BASE_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
]

/** Production-only: TLS terminates at the platform proxy, never here directly. */
export const HSTS_HEADER: SecurityHeader = {
  key: 'Strict-Transport-Security',
  value: 'max-age=31536000; includeSubDomains',
}

/**
 * The full header list for the given `NODE_ENV`, in the order Next should
 * send them.
 *
 * **When this is decided.** `next.config.ts`'s `headers()` calls this once, at
 * BUILD time: Next evaluates the config's `headers()` during `next build` and
 * writes the resulting list into `.next/server/routes-manifest.json`, which
 * the running server replays per request. So the `nodeEnv` that matters is the
 * BUILDER's, not the runtime's — a server started with `NODE_ENV=development`
 * against a production build still sends HSTS, and a build run with a
 * non-production `NODE_ENV` omits it no matter how the server is started.
 * Next's CLI defaults every non-dev command to `NODE_ENV=production`, so a
 * plain `next build` (and the Dockerfile's builder stage, which deliberately
 * does not override it) produces the production set.
 */
export function securityHeadersFor(nodeEnv: string | undefined): SecurityHeader[] {
  return isProductionMode(nodeEnv)
    ? [...BASE_SECURITY_HEADERS, HSTS_HEADER]
    : [...BASE_SECURITY_HEADERS]
}
