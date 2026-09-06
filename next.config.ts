import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const nextConfig: NextConfig = {
  // The dev tools indicator defaults to bottom-left, which overlaps
  // AppShell's logout control (also bottom-left of the desktop rail) and can
  // swallow clicks meant for it; bottom-right is clear in both the desktop
  // rail and the mobile bar (whose raised Add action is bottom-centre).
  devIndicators: { position: 'bottom-right' },
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
