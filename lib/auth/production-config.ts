import { parseTrustedProxies } from './trusted-proxies'

/**
 * Fails a production boot that is missing configuration auth cannot be safe
 * without. Called at module load by `lib/auth/auth.ts`, so a misconfigured
 * deployment crashes on start rather than serving requests with a broken
 * security property.
 *
 * - `BETTER_AUTH_URL` — without it Better Auth derives its base URL from the
 *   request, so an attacker-controlled `Host` header can end up inside the
 *   password-reset link that gets emailed to a real user.
 * - `TRUSTED_PROXY_CIDRS` — rate limiting keys on the client IP resolved from
 *   `x-forwarded-for`. Behind a proxy that appends to the chain, Better Auth
 *   resolves no IP at all unless it knows which hops to strip, and every
 *   caller collapses into one shared bucket.
 *
 * Kept in its own module (rather than inline in `lib/auth/auth.ts`) so it is
 * testable without importing the app's Prisma-backed auth singleton.
 *
 * Never interpolates a value into the message — only the variable name, so a
 * secret can never reach a log through a boot failure.
 *
 * `next build` runs with `NODE_ENV=production` but is not a boot: it imports
 * every route module to collect page data while serving no requests, and CI
 * builds legitimately have neither variable. Next marks that pass by setting
 * `process.env.NEXT_PHASE = 'phase-production-build'`
 * (`node_modules/next/dist/build/index.js`), which is the one production case
 * exempted here. `next start` and any serverless runtime leave `NEXT_PHASE`
 * unset, so a real production process is still checked.
 */
const NEXT_BUILD_PHASE = 'phase-production-build'

export function assertProductionAuthConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return
  if (env.NEXT_PHASE === NEXT_BUILD_PHASE) return

  const missing: string[] = []
  if (typeof env.BETTER_AUTH_URL !== 'string' || env.BETTER_AUTH_URL.trim() === '') {
    missing.push('BETTER_AUTH_URL')
  }
  if (parseTrustedProxies(env.TRUSTED_PROXY_CIDRS).length === 0) {
    missing.push('TRUSTED_PROXY_CIDRS')
  }

  if (missing.length > 0) {
    throw new Error(
      `Auth is not configured for production: set ${missing.join(' and ')}. ` +
        'BETTER_AUTH_URL pins the origin used in emailed reset links; ' +
        'TRUSTED_PROXY_CIDRS is the comma-separated list of CIDRs/IPs of the ' +
        'reverse proxy or CDN that sets x-forwarded-for, without which rate ' +
        'limiting cannot identify a client.',
    )
  }
}
