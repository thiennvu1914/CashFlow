import { NAV_ITEMS, type NavItem } from './nav-items'

/**
 * The rail's five groups (spec §5), so twelve destinations read as a structure
 * rather than a list: Tổng quan, then the things money moves through, then the
 * things you plan with, then Báo cáo, then Cài đặt.
 *
 * Built by looking each href up in `NAV_ITEMS` rather than re-declaring items,
 * so a group and the flat list cannot disagree about an icon or a label — and
 * a typo fails at module load, exactly as `MOBILE_TAB_ITEMS` does.
 *
 * `NAV_ITEMS` stays the flat source of truth: the mobile bar and the More sheet
 * use it directly, and `nav-groups.test.ts` asserts the groups partition it
 * exactly (every destination once, nothing invented, nothing lost).
 */
export interface NavGroup {
  id: string
  headerKey: string
  items: NavItem[]
}

function itemsFor(hrefs: string[]): NavItem[] {
  return hrefs.map((href) => {
    const item = NAV_ITEMS.find((candidate) => candidate.href === href)
    if (!item) throw new Error(`NAV_GROUPS references an unknown route: ${href}`)
    return item
  })
}

export const NAV_GROUPS: NavGroup[] = [
  { id: 'overview', headerKey: 'nav.groupOverview', items: itemsFor(['/dashboard']) },
  {
    id: 'money',
    headerKey: 'nav.groupMoney',
    items: itemsFor(['/transactions', '/transfers', '/accounts', '/categories']),
  },
  {
    id: 'planning',
    headerKey: 'nav.groupPlanning',
    items: itemsFor(['/budgets', '/goals', '/debts', '/loans', '/reminders']),
  },
  { id: 'reports', headerKey: 'nav.groupReports', items: itemsFor(['/reports']) },
  { id: 'settings', headerKey: 'nav.groupSettings', items: itemsFor(['/settings']) },
]
