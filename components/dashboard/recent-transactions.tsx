import Link from 'next/link'
import { cn } from 'cn'
import type { RecentTransactionDto } from '@/lib/ui/dashboard-view-model'
import { DashboardEmpty } from './dashboard-section'

/**
 * The last five entries, each with its local date-time, its account and a
 * signed amount in its own currency.
 *
 * Amounts are *not* restated in the display currency here. This is a ledger
 * excerpt, not an aggregate: the row should say what the user entered, and
 * converting it would introduce a rate into a place where none is needed.
 * Every aggregate on this page is converted; this one list is not, which is why
 * each amount carries its currency code.
 */
export function RecentTransactions({ transactions }: { transactions: RecentTransactionDto[] }) {
  if (transactions.length === 0) {
    return (
      <DashboardEmpty>
        <span>
          No transactions yet —{' '}
          <Link href="/transactions#new" className="text-brand underline-offset-4 hover:underline">
            add your first one
          </Link>
        </span>
      </DashboardEmpty>
    )
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {transactions.map((tx) => (
        <li key={tx.id} className="flex items-baseline justify-between gap-4 py-2 first:pt-0">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{tx.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              <span className="tabular-nums">{tx.when}</span> · {tx.accountName}
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 text-sm tabular-nums',
              tx.positive ? 'text-positive' : 'text-negative',
            )}
          >
            {tx.amount}{' '}
            <span className="text-xs font-normal text-muted-foreground">{tx.currency}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
