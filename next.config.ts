import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
// Relative import, not the `@/*` alias: `next.config.ts` is loaded by Next's
// own minimal TS loader before the app's path-alias resolution is set up.
import { securityHeadersFor } from './lib/server/security-headers'

const nextConfig: NextConfig = {
  // Emit `.next/standalone`: a self-contained `server.js` plus only the
  // `node_modules` files Next's trace proves are reachable. That is what the
  // Dockerfile's runner stage ships, and it is why the runner needs neither a
  // full `npm ci` nor the Prisma CLI. Prisma 7's WASM client is traced
  // correctly because it is loaded through static `require` strings; the
  // Dockerfile records the verification.
  output: 'standalone',
  // Off, not repositioned. AppShell occupies the bottom edge at *every*
  // breakpoint, so no corner is free: the desktop rail's logout control sits
  // bottom-left, and below `md` the tab bar spans the full width — bottom-right
  // is the Reports tab. Wherever the floating indicator lands it overlays a
  // control and swallows clicks meant for it (it is a `<nextjs-portal>` fixed
  // above the page). It is a dev-only affordance and this is a dev-only
  // setting; the production build never renders it either way.
  devIndicators: false,
  // `X-Powered-By: Next.js` is on by default; it costs nothing to remove and
  // tells nothing useful to an attacker.
  poweredByHeader: false,
  // Applies to every route, including API routes (`/api/health` included) —
  // see `lib/server/security-headers.ts` for the header set and the
  // production-only HSTS reasoning.
  //
  // This function runs at BUILD time, not per request: Next calls it while
  // building and writes the result into `.next/server/routes-manifest.json`,
  // which the running server replays. So `process.env.NODE_ENV` below is the
  // BUILDER's, and whether HSTS ships is decided by whoever ran `next build`
  // — a runner started with a different NODE_ENV cannot add or remove it.
  // Next's CLI defaults `NODE_ENV` to `production` for every non-dev command,
  // so a plain `next build` (including the Dockerfile's builder stage, which
  // deliberately does not override it) bakes HSTS in.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeadersFor(process.env.NODE_ENV),
      },
    ]
  },
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
