import { getTranslations } from 'next-intl/server'
import { SegmentedControl } from '@/components/common/segmented-control'

/**
 * The tab pairs the sidebar groups under one entry: Giao dịch / Chuyển tiền and
 * Công nợ / Khoản vay. Each tab is still its own route (old URLs keep working),
 * so this is plain links in the shared segmented control — `aria-current="page"`
 * on the active one, keyboard-focusable, no client JavaScript.
 */
const SECTIONS = {
  transactions: {
    labelKey: 'nav.transactions',
    tabs: [
      { id: 'transactions', href: '/transactions', labelKey: 'nav.transactions' },
      { id: 'transfers', href: '/transfers', labelKey: 'nav.transfers' },
    ],
  },
  debts: {
    labelKey: 'nav.debtsLoans',
    tabs: [
      { id: 'debts', href: '/debts', labelKey: 'nav.debts' },
      { id: 'loans', href: '/loans', labelKey: 'nav.loans' },
    ],
  },
} as const

export async function SectionTabs({
  section,
  active,
}: {
  section: keyof typeof SECTIONS
  active: string
}) {
  const t = await getTranslations()
  const { labelKey, tabs } = SECTIONS[section]
  return (
    <SegmentedControl
      label={t(labelKey)}
      activeId={active}
      segments={tabs.map((tab) => ({ id: tab.id, href: tab.href, label: t(tab.labelKey) }))}
      className="self-start"
    />
  )
}
