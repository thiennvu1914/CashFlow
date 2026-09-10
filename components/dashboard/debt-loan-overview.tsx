import { cn } from 'cn'
import type { Currency } from '@/lib/currency/provider'
import type { DebtLoanOverviewDto } from '@/lib/ui/dashboard-view-model'

/**
 * The three current-position aggregates behind the Net Worth card: what is owed
 * to the user, what they owe on debts, and what principal is still outstanding
 * on their loans.
 *
 * A server component with no state of its own and no arithmetic: every figure
 * is already a formatted string from `buildDashboardViewModel`, so no
 * `Prisma.Decimal` — which could not cross a client boundary anyway — and no
 * currency conversion happen here. The position converted all three at its one
 * current rate before they arrived, which is why they may be read as a column.
 *
 * A definition list rather than a table or three cards: three named figures are
 * terms and their values, the `dl` says exactly that to a screen reader, and
 * three cards would put two gutters between numbers the reader is meant to take
 * in together (the same reasoning as `KpiStrip`).
 *
 * The footnote is not decoration. Without it these are three numbers with no
 * stated relationship to the Net Worth card above them — and that relationship
 * is the only reason they are on a dashboard whose every other figure is a
 * balance.
 */

/**
 * The three rows, in the order the Net Worth formula reads: the asset, then the
 * two liabilities.
 *
 * Only the meaning carries colour, and it carries it consistently — a
 * receivable is money coming, a payable and a loan are money going. Each row is
 * named in words as well, so nothing here depends on seeing the difference
 * between green and red.
 */
const ROWS = [
  { key: 'receivables', labelKey: 'dashboard.receivables', tone: 'text-positive' },
  { key: 'payables', labelKey: 'dashboard.payables', tone: 'text-negative' },
  { key: 'loanOutstanding', labelKey: 'dashboard.loanOutstanding', tone: 'text-negative' },
] as const satisfies readonly { key: keyof DebtLoanOverviewDto; labelKey: string; tone: string }[]

export function DebtLoanOverview({
  data,
  currency,
  labels,
  footnote,
}: {
  data: DebtLoanOverviewDto
  /** The currency all three figures are already stated in. */
  currency: Currency
  /** Already-translated labels, keyed by each row's `labelKey`. */
  labels: Record<string, string>
  /** Already-translated: `dashboard.debtLoanIncluded`. */
  footnote: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        {ROWS.map(({ key, labelKey, tone }) => (
          // A wrapper `div` per pair, as in `KpiStrip`: a `dl` may contain only
          // `dt`/`dd` (or `div`s of them), and it is what lets each row be one
          // flex line.
          <div key={key} className="flex items-baseline justify-between gap-2">
            <dt className="text-sm text-muted-foreground">{labels[labelKey]}</dt>
            {/* `tabular-nums` so the three figures' digits line up into a
                column that can be compared at a glance, and `whitespace-nowrap`
                so a figure never breaks mid-number — only the currency suffix
                may wrap away from it. */}
            <dd className={cn('flex flex-wrap items-baseline justify-end gap-x-1 text-sm', tone)}>
              <span className="font-medium whitespace-nowrap tabular-nums">{data[key]}</span>
              <span className="text-xs text-muted-foreground">{currency}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{footnote}</p>
    </div>
  )
}
