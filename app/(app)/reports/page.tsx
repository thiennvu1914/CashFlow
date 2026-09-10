import type { Prisma } from '@prisma/client'
import { PieChart, Wallet } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { isRealCalendarDate } from '@/lib/datetime/calendar-date'
import { resolveLocale } from '@/lib/i18n/config'
import type { Locale } from '@/lib/i18n/locale'
import {
  InvalidReportRangeError,
  describeRange,
  rangeToQueryString,
  resolveReportRange,
  type ReportRange,
} from '@/lib/reports/report-range'
import { getActivitySummary } from '@/lib/server/services/activity'
import { formatDate } from '@/lib/ui/format-date'
import { formatMoney, formatPercent } from '@/lib/ui/format-money'
import type { KpiDto } from '@/lib/ui/dashboard-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { ChartContainer } from '@/components/common/chart-container'
import { EmptyState } from '@/components/common/empty-state'
import { InlineAlert } from '@/components/common/inline-alert'
import { PageHeader } from '@/components/common/page-header'
import { SummaryPanel } from '@/components/dashboard/summary-panel'
import { AccountTable } from '@/components/reports/account-table'
import { CategoryBars } from '@/components/reports/category-bars'
import { ExportMenu } from '@/components/reports/export-menu'
import { PeriodFilter } from '@/components/reports/period-filter'

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
 * The invalid-range `InlineAlert`'s id (fix round 1, promoted minor) — both
 * date inputs in `PeriodFilter`'s custom-range form point `aria-describedby`
 * at it, so a screen-reader user tabbing into From/To hears why the range
 * they typed did not apply.
 */
const RANGE_ERROR_ID = 'report-range-error'

/**
 * A raw `from`/`to` echoed back into the form after a rejected range, so the
 * user can correct one field instead of retyping both. Only a value that is
 * already a real calendar date is echoed: there is nothing to preserve about
 * `?from=garbage`, and the date input cannot hold it anyway.
 */
function echoableDate(value: string | string[] | undefined): string {
  return typeof value === 'string' && isRealCalendarDate(value) ? value : ''
}

/**
 * A category's share of total expense, as a rounded percent string.
 *
 * Explicitly guarded (fix round 1, promoted minor) rather than the previous
 * `expenseTotal.isZero() ? total : expenseTotal` fallback, which still
 * reached `0/0` — a literal "NaN %" — whenever a zero-total row somehow
 * appeared alongside zero total expense. `getActivitySummary`'s aggregation
 * should never produce a zero-total category row in practice (a category
 * only enters the map when a transaction adds to it), but this is the number
 * a screen reader announces for `CategoryBars`' now-decorative bar, so it
 * does not get to rely on an implicit invariant elsewhere.
 */
function categoryPercentLabel(
  total: Prisma.Decimal,
  expenseTotal: Prisma.Decimal,
  locale: Locale,
): string {
  // Rounded on the `Decimal` first (unchanged rounding semantics — decimal.js'
  // default mode is ROUND_HALF_UP); `formatPercent` only formats that
  // already-rounded whole number for the reader's locale and appends the
  // sign, never a rounding of its own.
  if (expenseTotal.isZero()) return formatPercent(0, locale)
  return formatPercent(total.div(expenseTotal).mul(100).toDecimalPlaces(0), locale)
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
  const t = await getTranslations()
  const locale = await resolveLocale()

  let range: ReportRange
  try {
    range = resolveReportRange(params, timezone)
  } catch (error) {
    // Exactly `InvalidReportRangeError`, never a bare `catch`: a hand-typed
    // `?period=weekly` is the user's mistake and deserves a sentence, while a
    // database fault is not and must still surface as an error.
    if (!(error instanceof InvalidReportRangeError)) throw error
    // The specific reason is not lost, it just stops being shown to the
    // reader: it goes to the server log, where a developer chasing a bad link
    // can still read which of the six checks refused it.
    //
    // `warn`, not `error`: a hand-typed query parameter that the resolver
    // rejected is a handled input, not a fault — and in `next dev` a
    // `console.error` during a server render is counted by the dev overlay's
    // issue badge, which would put a red "1 Issue" on screen every time
    // someone typed a bad range.
    console.warn(`Reports: invalid range — ${error.message}`)
    return (
      <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
        <PageHeader
          title={t('reports.title')}
          description={t('reports.chooseRange', { currency: displayCurrency })}
          meta={t('reports.conversionNote')}
          actions={
            <ExportMenu
              label={t('reports.export')}
              filteredHref={null}
              filteredLabel={t('reports.exportRange')}
              fullHref="/api/reports/export?mode=full"
              fullLabel={t('reports.exportAll')}
            />
          }
        />
        <PeriodFilter
          activeKind="custom"
          from={echoableDate(params.from)}
          to={echoableDate(params.to)}
          errorId={RANGE_ERROR_ID}
        />
        {/* One localized sentence, not `error.message` (Task 17 fix round 1,
            controller item): `InvalidReportRangeError` carries only a
            developer message — English, written for a stack trace, and thrown
            from six call sites ("Unknown period \"weekly\" — expected one of
            day, week, month, quarter, year or custom") — so rendering it put
            app-internal text on a Vietnamese screen. It exposes no CODE to map
            per reason, and re-deriving which of the six failed would mean
            duplicating the resolver's logic here, so this is deliberately ONE
            sentence naming both things the reader can do; the control above
            and the echoed dates below are what they act on. `lib/reports/` is
            untouched. */}
        <InlineAlert id={RANGE_ERROR_ID} tone="negative">
          {t('reports.invalidRange')}
        </InlineAlert>
      </div>
    )
  }

  const summary = await getActivitySummary(user.id, displayCurrency, range)
  const { fromLabel, toLabelInclusive } = describeRange(range, timezone)

  // The only place a `Decimal` becomes a string on this page.
  const kpis: KpiDto[] = [
    {
      labelKey: 'reports.income',
      value: formatMoney(summary.income, displayCurrency, locale),
      negative: false,
    },
    // Expense is aggregated as a positive magnitude — red by meaning, not by
    // sign — so it is never marked negative here.
    {
      labelKey: 'reports.expense',
      value: formatMoney(summary.expense, displayCurrency, locale),
      negative: false,
    },
    {
      labelKey: 'reports.netIncome',
      value: formatMoney(summary.netIncome, displayCurrency, locale),
      negative: summary.netIncome.isNegative(),
    },
  ]

  // Bars are relative to the LARGEST category, not the total — see CategoryBars.
  const largest = summary.byCategory[0]?.total
  const categoryRows = summary.byCategory.map((row) => ({
    id: row.categoryId ?? 'uncategorized',
    name: row.name,
    amount: formatMoney(row.total, displayCurrency, locale),
    percent: largest && !largest.isZero() ? row.total.div(largest).mul(100).toNumber() : 0,
    percentLabel: categoryPercentLabel(row.total, summary.expense, locale),
  }))

  const accountRows = summary.byAccount.map((row) => ({
    id: row.accountId,
    name: row.name,
    income: formatMoney(row.income, displayCurrency, locale),
    expense: formatMoney(row.expense, displayCurrency, locale),
    netIncome: formatMoney(row.netIncome, displayCurrency, locale),
    netNegative: row.netIncome.isNegative(),
  }))

  return (
    <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-6 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('reports.title')}
        description={t('reports.rangeText', {
          from: formatDate(fromLabel, { locale, timeZone: timezone, style: 'date' }),
          to: formatDate(toLabelInclusive, { locale, timeZone: timezone, style: 'date' }),
          currency: displayCurrency,
        })}
        // Always shown, though it only bites for a user with accounts in more
        // than one currency: every figure on this page is history, restated at
        // the rate each row snapshotted when it was entered — never at today's
        // rate. Someone comparing a report against a bank statement, or against
        // the same report run last month, needs to know that up front, and a
        // caption that appeared only sometimes would be missed exactly when it
        // mattered.
        meta={t('reports.conversionNote')}
        actions={
          <ExportMenu
            label={t('reports.export')}
            filteredHref={`/api/reports/export?mode=filtered&${rangeToQueryString(range)}`}
            filteredLabel={t('reports.exportRange')}
            fullHref="/api/reports/export?mode=full"
            fullLabel={t('reports.exportAll')}
          />
        }
      />

      <PeriodFilter
        activeKind={range.kind}
        from={range.kind === 'custom' ? range.from : ''}
        to={range.kind === 'custom' ? range.to : ''}
      />

      <SummaryPanel
        variant="flat"
        kpis={kpis}
        currency={displayCurrency}
        labels={{
          'reports.income': t('reports.income'),
          'reports.expense': t('reports.expense'),
          'reports.netIncome': t('reports.netIncome'),
        }}
        hints={{}}
      />

      <ChartContainer title={t('reports.byCategory')} caption={t('reports.byCategoryCaption')}>
        {categoryRows.length === 0 ? (
          <EmptyState icon={PieChart} title={t('reports.emptyCategory')} />
        ) : (
          <CategoryBars rows={categoryRows} currency={displayCurrency} />
        )}
      </ChartContainer>

      <ChartContainer title={t('reports.byAccount')} caption={displayCurrency}>
        {accountRows.length === 0 ? (
          <EmptyState icon={Wallet} title={t('reports.emptyAccount')} />
        ) : (
          <AccountTable
            rows={accountRows}
            currency={displayCurrency}
            labels={{
              account: t('reports.account'),
              income: t('reports.income'),
              expense: t('reports.expense'),
              netIncome: t('reports.netIncome'),
            }}
          />
        )}
      </ChartContainer>
    </div>
  )
}
