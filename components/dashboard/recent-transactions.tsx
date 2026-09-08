import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { cn } from 'cn'
import { Receipt } from 'lucide-react'
import { EmptyState } from '@/components/common/empty-state'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { MoneyText } from '@/components/common/money-text'
import type { Locale } from '@/lib/i18n/locale'
import type { RecentTransactionDto } from '@/lib/ui/dashboard-view-model'
import { formatDate } from '@/lib/ui/format-date'
import { transactionTypeLabelKey } from '@/lib/ui/labels'

/**
 * The last few entries, each with its local date-time, its account and a
 * signed amount in its own currency.
 *
 * Amounts are NOT restated in the display currency here. This is a ledger
 * excerpt, not an aggregate: the row should say what the user entered, and
 * converting it would introduce a rate where none is needed. Every aggregate on
 * the dashboard is converted; this one list is not, which is why each amount
 * carries its currency code.
 *
 * The row's title is the category name, or — when there is none — the TYPE's
 * translated label. It used to be `category?.name ?? tx.type`, which is how
 * `CASH_OUT` appeared on the dashboard verbatim.
 */
export async function RecentTransactions({
  transactions,
  locale,
  timeZone,
  mobileLimit,
}: {
  transactions: RecentTransactionDto[]
  locale: Locale
  timeZone: string
  /** Rows at or past this index carry `hidden xl:flex` — the ledger shows every
   *  row on desktop and only the first `mobileLimit` in the mobile stack, from
   *  ONE fetch rather than two (spec §6.1 row 7 and the mobile order). */
  mobileLimit?: number
}) {
  const t = await getTranslations()

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title={t('dashboard.emptyTransactionsTitle')}
        description={t('dashboard.emptyTransactionsBody')}
        action={{ label: t('dashboard.emptyTransactionsAction'), href: '/transactions#new' }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border">
        {transactions.map((tx, index) => (
          <FinancialListRow
            key={tx.id}
            className={cn(
              'px-0',
              mobileLimit !== undefined && index >= mobileLimit && 'hidden xl:flex',
            )}
            title={tx.categoryName ?? t(transactionTypeLabelKey(tx.type))}
            meta={
              <>
                <span className="tabular-nums">
                  {formatDate(tx.date, { locale, timeZone, style: 'dateTime' })}
                </span>
                {' · '}
                {tx.accountName}
              </>
            }
            amount={
              <MoneyText
                value={tx.amount}
                currency={tx.currency}
                tone={tx.positive ? 'positive' : 'default'}
              />
            }
          />
        ))}
      </ul>
      <Link
        href="/transactions"
        className="self-start text-[0.8125rem]/[1.125rem] text-brand underline-offset-4 hover:underline"
      >
        {t('dashboard.viewAllTransactions')}
      </Link>
    </div>
  )
}
