import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
// Relative import, not the `@/*` alias: `next.config.ts` is loaded by Next's
// own minimal TS loader before the app's path-alias resolution is set up.
import { securityHeadersFor } from './lib/server/security-headers'

const nextConfig: NextConfig = {
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
