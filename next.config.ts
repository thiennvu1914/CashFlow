import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const nextConfig: NextConfig = {
  // Off, not repositioned. AppShell occupies the bottom edge at *every*
  // breakpoint, so no corner is free: the desktop rail's logout control sits
  // bottom-left, and below `md` the tab bar spans the full width — bottom-right
  // is the Reports tab. Wherever the floating indicator lands it overlays a
  // control and swallows clicks meant for it (it is a `<nextjs-portal>` fixed
  // above the page). It is a dev-only affordance and this is a dev-only
  // setting; the production build never renders it either way.
  devIndicators: false,
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
