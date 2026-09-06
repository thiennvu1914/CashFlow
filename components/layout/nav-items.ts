import {
  ArrowLeftRight,
  ChartColumn,
  LayoutDashboard,
  Receipt,
  Settings,
  Tags,
  Target,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/**
 * The application's navigation, in one place, so the desktop rail and the
 * mobile bar can never drift apart about what exists or where it lives.
 *
 * Only routes that exist are listed — Budgets is here now that Phase 5 has
 * shipped `/budgets`.
 */
export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/transactions', label: 'Transactions', icon: Receipt },
  { href: '/transfers', label: 'Transfers', icon: ArrowLeftRight },
  { href: '/accounts', label: 'Accounts', icon: Wallet },
  { href: '/budgets', label: 'Budgets', icon: Target },
  { href: '/categories', label: 'Categories', icon: Tags },
  { href: '/reports', label: 'Reports', icon: ChartColumn },
  { href: '/settings', label: 'Settings', icon: Settings },
]

/**
 * The four the mobile tab bar shows. A phone bar with seven targets is a bar
 * with no targets: the rest live behind "More", which is a deliberate
 * prioritisation rather than a truncation of `NAV_ITEMS`.
 */
export const MOBILE_TAB_HREFS = ['/dashboard', '/transactions', '/accounts', '/reports']

/** Everything the tab bar does not show, in `NAV_ITEMS` order — the "More" menu. */
export const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => !MOBILE_TAB_HREFS.includes(item.href))

/** The tab-bar items, in the order `MOBILE_TAB_HREFS` declares. */
export const MOBILE_TAB_ITEMS = MOBILE_TAB_HREFS.map((href) => {
  const item = NAV_ITEMS.find((candidate) => candidate.href === href)
  // A typo in `MOBILE_TAB_HREFS` would otherwise render a bar with a hole in
  // it; failing at module load makes it a build-time mistake instead.
  if (!item) throw new Error(`MOBILE_TAB_HREFS references an unknown route: ${href}`)
  return item
})

/** Where the "Add transaction" action goes — the transactions page's entry form. */
export const ADD_TRANSACTION_HREF = '/transactions#new'

/**
 * True when `href` is the section the user is currently in. A prefix match (not
 * just equality) so a future `/transactions/<id>` detail page still lights up
 * its parent tab, while `/` never matches anything but itself.
 */
export function isActiveNavItem(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}
