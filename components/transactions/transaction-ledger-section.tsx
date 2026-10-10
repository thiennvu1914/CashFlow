import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import type { Currency } from '@prisma/client'
import { getTranslations } from 'next-intl/server'
import type { Locale } from '@/lib/i18n/locale'
import { getActivitySummary } from '@/lib/server/services/activity'
import { listTransactions } from '@/lib/server/services/transaction'
import { formatMoney } from '@/lib/ui/format-money'
import { Skeleton } from '@/components/common/skeleton'
import { TransactionList } from './transaction-list'

/**
 * The ledger, as its own async server component so the page can stream it
 * behind the create form: the 200-row query is the slowest read on the page and
 * nothing the form needs depends on it. `userId` comes from the page, which has
 * already called `requireUserOrRedirect()`.
 *
 * A create or delete action's `revalidatePath` re-renders this route, and the
 * section re-reads inside its Suspense boundary, so the ledger still updates.
 */
export async function TransactionLedgerSection({
  userId,
  timezone,
  locale,
  today,
  yesterday,
}: {
  userId: string
  timezone: string
  locale: Locale
  today: string
  yesterday: string
}) {
  const transactions = await listTransactions(userId)
  return (
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
  )
}

/**
 * The header's month total, behind its own boundary so the title and the "add"
 * button never wait for the summary. Historical, restated at each row's own
 * snapshot, so it consults no current rate and an FX outage cannot reach it.
 */
export async function TransactionsMonthTotal({
  userId,
  displayCurrency,
  timezone,
  locale,
  now,
}: {
  userId: string
  displayCurrency: Currency
  timezone: string
  locale: Locale
  now: Date
}) {
  const t = await getTranslations()
  const monthly = await getActivitySummary(
    userId,
    displayCurrency,
    getPeriodBounds(timezone, 'month', now),
  )
  return t('transactions.monthTotal', {
    amount: formatMoney(monthly.expense, displayCurrency, locale),
    currency: displayCurrency,
  })
}

/**
 * The ledger card's shape, in grey — the same rows `PageSkeleton` draws, but as
 * plain `div`s rather than a `ul`/`li`: placeholders are not list items, and a
 * real `listitem` here is what a test (or a screen reader) would find before
 * the ledger's own rows exist.
 */
export function TransactionLedgerSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
