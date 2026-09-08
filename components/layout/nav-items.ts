import {
  ArrowLeftRight,
  BellRing,
  ChartColumn,
  HandCoins,
  Landmark,
  LayoutDashboard,
  PiggyBank,
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
 * Only routes that exist are listed — Budgets since Phase 5 shipped
 * `/budgets`, Savings since Phase 6's first group shipped `/goals`, Debts
 * since its third group shipped `/debts`, Loans since its fifth group shipped
 * `/loans`, and Reminders now that its seventh group has shipped
 * `/reminders`. The mobile tab bar is unchanged: `MOBILE_TAB_HREFS` names the
 * four routes it shows, so Savings, Debts, Loans and Reminders join the "More"
 * menu on their own.
 */
/**
 * `labelKey`, not `label`: the rail, the bottom bar and the More sheet all
 * render the same item, and Phase 7 renders it in the reader's language — so
 * the item carries the KEY and whichever component draws it calls `t`. A
 * display string here would have to be translated three times, or once in a
 * place that has no translator.
 */
export interface NavItem {
  href: string
  labelKey: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { href: '/transactions', labelKey: 'nav.transactions', icon: Receipt },
  { href: '/transfers', labelKey: 'nav.transfers', icon: ArrowLeftRight },
  { href: '/accounts', labelKey: 'nav.accounts', icon: Wallet },
  { href: '/budgets', labelKey: 'nav.budgets', icon: Target },
  { href: '/goals', labelKey: 'nav.goals', icon: PiggyBank },
  { href: '/debts', labelKey: 'nav.debts', icon: HandCoins },
  { href: '/loans', labelKey: 'nav.loans', icon: Landmark },
  { href: '/reminders', labelKey: 'nav.reminders', icon: BellRing },
  { href: '/categories', labelKey: 'nav.categories', icon: Tags },
  { href: '/reports', labelKey: 'nav.reports', icon: ChartColumn },
  { href: '/settings', labelKey: 'nav.settings', icon: Settings },
]

/**
 * The four the mobile tab bar shows. A phone bar with nine targets is a bar
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
