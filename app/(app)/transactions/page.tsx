import { Wallet } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { resolveLocale } from '@/lib/i18n/config'
import { getActivitySummary } from '@/lib/server/services/activity'
import { getAccountBalancesForAccounts } from '@/lib/server/services/balance'
import { listCategories } from '@/lib/server/services/category'
import { listActiveFinancialAccounts } from '@/lib/server/services/financial-account'
import { listTransactions } from '@/lib/server/services/transaction'
import { formatMoney } from '@/lib/ui/format-money'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import {
  TransactionCreatePanelBody,
  TransactionCreatePanelProvider,
  TransactionCreateTrigger,
} from '@/components/transactions/transaction-create-panel'
import { TransactionList } from '@/components/transactions/transaction-list'

/** One day, in milliseconds — for computing "yesterday" from "now". */
const MS_PER_DAY = 24 * 60 * 60 * 1000

export default async function TransactionsPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  const locale = await resolveLocale()
  const t = await getTranslations()
  // ONE `now` for the whole request, so the month total, the day headers and
  // the form's pre-filled "now" cannot straddle midnight.
  const now = new Date()
  const today = todayCalendarDateInZone(timezone, now)
  const yesterday = todayCalendarDateInZone(timezone, new Date(now.getTime() - MS_PER_DAY))

  const [transactions, accounts, categories, monthly] = await Promise.all([
    listTransactions(user.id),
    listActiveFinancialAccounts(user.id),
    // Both transaction types use the same picker payload. One tenant-scoped
    // read preserves the service ordering and avoids two parallel queries for
    // rows that are concatenated again below.
    listCategories(user.id),
    // The header's month total. The same call the dashboard makes for the same
    // window — historical, restated at each row's own snapshot, so it consults
    // no current rate and an FX outage cannot reach it.
    getActivitySummary(user.id, displayCurrency, getPeriodBounds(timezone, 'month', now)),
  ])

  const monthTotalDescription = t('transactions.monthTotal', {
    amount: formatMoney(monthly.expense, displayCurrency, locale),
    currency: displayCurrency,
  })

  /**
   * Zero active accounts (spec §14 fix round 1, finding 6): the page itself
   * — not just `TransactionForm` — replaces its whole body with ONE notice.
   * A first pass left the list's own "Chưa có giao dịch" empty state and the
   * create panel's own no-account notice as two SEPARATE things, reachable
   * only after opening the sheet on a phone — so a brand-new user's very
   * first visit read as "nothing to see here" until they went looking. No
   * header/mobile create trigger is rendered in this branch either: there is
   * nothing yet for it to create a transaction against.
   */
  if (accounts.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
        <PageHeader title={t('transactions.title')} description={monthTotalDescription} />
        <EmptyState
          icon={Wallet}
          size="page"
          title={t('transactions.noAccountTitle')}
          description={t('transactions.noAccountBody')}
          action={{ label: t('transactions.noAccountAction'), href: '/accounts' }}
        />
      </div>
    )
  }

  // The account picker shows each account's balance (spec §2). Reuse the
  // already tenant-scoped active rows above, retaining the helper's ownership
  // validation and user-scoped aggregates without a duplicate account lookup.
  const balances = await getAccountBalancesForAccounts(user.id, accounts, now)

  const accountOptions = accounts.map((account) => {
    const balance = balances.get(account.id)
    if (!balance) throw new Error(`Missing balance for account ${account.id}`)
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      // A `Prisma.Decimal` cannot cross the server-to-client-component
      // boundary, so the balance crosses as a fixed-2-decimal string and is
      // formatted for display only — no arithmetic happens on the client.
      balance: balance.toFixed(2),
    }
  })

  return (
    <TransactionCreatePanelProvider
      accounts={accountOptions}
      categories={categories.map((category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
      }))}
      timezone={timezone}
      locale={locale}
    >
      {/* max-w 1200 because the two-column desktop layout needs it. */}
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
        <PageHeader
          title={t('transactions.title')}
          description={monthTotalDescription}
          actions={<TransactionCreateTrigger />}
        />

        {/* 7/12 + 5/12 at ≥ 1280 (spec §6.2); below that, one column, the
            create panel's own `md:flex`/`xl:sticky` classes give it the
            tablet composition (full width, below the list) and the sheet
            (below `md`) needs no grid cell at all. */}
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
          <div className="xl:col-span-7">
            <TransactionList
              transactions={transactions.map((tx) => ({
                id: tx.id,
                type: tx.type,
                // A `Prisma.Decimal` cannot cross the server-to-client-component
                // boundary, so the amount crosses as a fixed-2-decimal string and
                // is formatted for display only — no arithmetic on the client.
                amount: tx.amount.toFixed(2),
                currency: tx.currency,
                date: tx.date,
                note: tx.note,
                fxRateSource: tx.fxRateSource,
                account: { name: tx.account.name },
                category: tx.category ? { name: tx.category.name } : null,
              }))}
              timezone={timezone}
              locale={locale}
              today={today}
              yesterday={yesterday}
            />
          </div>
          <TransactionCreatePanelBody />
        </div>
      </div>
    </TransactionCreatePanelProvider>
  )
}
