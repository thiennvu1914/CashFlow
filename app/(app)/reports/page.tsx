import { cn } from 'cn'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { isRealCalendarDate } from '@/lib/datetime/calendar-date'
import {
  InvalidReportRangeError,
  describeRange,
  rangeToQueryString,
  resolveReportRange,
  type ReportRange,
} from '@/lib/reports/report-range'
import { getActivitySummary } from '@/lib/server/services/activity'
import { formatMoney } from '@/lib/ui/format-money'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { DashboardEmpty, DashboardSection } from '@/components/dashboard/dashboard-section'
import { KpiStrip } from '@/components/dashboard/kpi-strip'
import { PeriodFilter } from '@/components/reports/period-filter'
import { buttonVariants } from '@/components/ui/button'

/**
 * Reports (spec §5.6): one window of history, three ways — the headline totals,
 * where the money went, and which account it moved through.
 *
 * The window itself comes from the URL and nowhere else, resolved by the single
 * `resolveReportRange`. Everything below then flows from that one range: the
 * figures, the header's date labels, and the export links' query string — so
 * the spreadsheet a user downloads covers exactly the rows they were looking
 * at, including a custom `from`/`to`.
 *
 * Every figure is *historical* and comes through `getActivitySummary`, which
 * restates each row at the rate that row snapshotted at entry. No current FX
 * rate is read on this page at all, so a report about March answers the same
 * number today and next year, and an FX outage cannot affect it.
 */

/** Query parameters as Next delivers them — untrusted, and never cast. */
type ReportsSearchParams = Record<string, string | string[] | undefined>

/**
 * A raw `from`/`to` echoed back into the form after a rejected range, so the
 * user can correct one field instead of retyping both. Only a value that is
 * already a real calendar date is echoed: there is nothing to preserve about
 * `?from=garbage`, and the date input cannot hold it anyway.
 */
function echoableDate(value: string | string[] | undefined): string {
  return typeof value === 'string' && isRealCalendarDate(value) ? value : ''
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<ReportsSearchParams>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything from the
  // query string — scopes the one query below.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  const params = await searchParams

  let range: ReportRange
  try {
    range = resolveReportRange(params, timezone)
  } catch (error) {
    // Exactly `InvalidReportRangeError`, never a bare `catch`: a hand-typed
    // `?period=weekly` is the user's mistake and deserves a sentence, while a
    // database fault is not and must still surface as an error.
    if (!(error instanceof InvalidReportRangeError)) throw error
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <ReportsHeader subtitle={`Choose a period · ${displayCurrency}`} exportQuery={null} />
        <PeriodFilter
          activeKind={null}
          from={echoableDate(params.from)}
          to={echoableDate(params.to)}
        />
        <p className="text-sm text-negative" role="alert">
          {error.message}
        </p>
      </div>
    )
  }

  const summary = await getActivitySummary(user.id, displayCurrency, range)
  const { fromLabel, toLabelInclusive } = describeRange(range, timezone)

  // The only place a `Decimal` becomes a string on this page.
  //
  // `labelKey` carries plain text here, not a message key: this page has no
  // translator of its own yet (Task 10 rewrites it), and `KpiStrip` — this
  // component's only remaining caller — renders whatever it is given
  // verbatim, exactly as it did when the field was named `label`.
  const kpis: KpiDto[] = [
    { labelKey: 'Income', value: formatMoney(summary.income, displayCurrency), negative: false },
    // Expense is aggregated as a positive magnitude — red by meaning, not by
    // sign — so it is never marked negative here.
    {
      labelKey: 'Expense',
      value: formatMoney(summary.expense, displayCurrency),
      negative: false,
    },
    {
      labelKey: 'Net Income',
      value: formatMoney(summary.netIncome, displayCurrency),
      negative: summary.netIncome.isNegative(),
    },
  ]

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <ReportsHeader
        subtitle={`${fromLabel} – ${toLabelInclusive} · ${displayCurrency}`}
        exportQuery={rangeToQueryString(range)}
      />

      <PeriodFilter
        activeKind={range.kind}
        from={range.kind === 'custom' ? range.from : fromLabel}
        to={range.kind === 'custom' ? range.to : toLabelInclusive}
      />

      <KpiStrip kpis={kpis} currency={displayCurrency} />

      <DashboardSection
        title="By Category"
        caption="Expenses only — an income row has no place in a spending breakdown"
      >
        {summary.byCategory.length === 0 ? (
          <DashboardEmpty>No expenses in this range</DashboardEmpty>
        ) : (
          <ul className="divide-y divide-border">
            {summary.byCategory.map((category) => (
              <li
                key={category.categoryId ?? 'uncategorized'}
                className="flex items-baseline justify-between gap-4 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{category.name}</span>
                <span className="tabular-nums">{formatMoney(category.total, displayCurrency)}</span>
              </li>
            ))}
          </ul>
        )}
      </DashboardSection>

      <DashboardSection title="By Account">
        {summary.byAccount.length === 0 ? (
          <DashboardEmpty>No activity in this range</DashboardEmpty>
        ) : (
          // The table can outgrow a phone; it scrolls inside its own box rather
          // than widening the page.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="py-2 text-left font-medium">
                    Account
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Income
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Expense
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Net Income
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.byAccount.map((account) => (
                  <tr key={account.accountId}>
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      {account.name}
                    </th>
                    <td className="py-2 pl-4 text-right tabular-nums">
                      {formatMoney(account.income, displayCurrency)}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums">
                      {formatMoney(account.expense, displayCurrency)}
                    </td>
                    <td
                      className={cn(
                        'py-2 pl-4 text-right font-medium tabular-nums',
                        account.netIncome.isNegative() && 'text-negative',
                      )}
                    >
                      {formatMoney(account.netIncome, displayCurrency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardSection>
    </div>
  )
}

/**
 * The page title, the window it covers, and the two export links.
 *
 * The links are plain anchors, not `next/link`: the response is a file
 * download, not a route, so a client-side navigation is the wrong mechanism.
 *
 * The filtered link's query string is built from `rangeToQueryString(range)` —
 * the *resolved* range, not the raw parameters — because that is what
 * guarantees `/api/reports/export` re-resolves the identical window through the
 * same `resolveReportRange` and exports exactly the rows this page is showing.
 */
function ReportsHeader({
  subtitle,
  exportQuery,
}: {
  subtitle: string
  /** `null` when no range resolved — there is nothing to export a filter of. */
  exportQuery: string | null
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
        {/* Always shown, though it only bites for a user with accounts in more
            than one currency: every figure on this page is history, restated at
            the rate each row snapshotted when it was entered — never at today's
            rate. Someone comparing a report against a bank statement, or
            against the same report run last month, needs to know that up front,
            and a caption that appeared only sometimes would be missed exactly
            when it mattered. */}
        <p className="text-xs text-muted-foreground">
          Converted at each transaction&rsquo;s exchange rate at entry
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {exportQuery !== null && (
          <a
            href={`/api/reports/export?mode=filtered&${exportQuery}`}
            className={buttonVariants({ variant: 'secondary' })}
          >
            Export this range (.xlsx)
          </a>
        )}
        <a
          href="/api/reports/export?mode=full"
          className={buttonVariants({ variant: 'secondary' })}
        >
          Export all data (.xlsx)
        </a>
      </div>
    </header>
  )
}
