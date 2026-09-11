import { getTranslations } from 'next-intl/server'
import { Target } from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import {
  getCalendarMonth,
  getCalendarMonthBounds,
  isBudgetableMonth,
  parseCalendarMonth,
  type CalendarMonth,
} from '@/lib/datetime/calendar-month'
import { resolveLocale } from '@/lib/i18n/config'
import { getBudgetProgressForMonth } from '@/lib/server/services/budget'
import { listCategories } from '@/lib/server/services/category'
import { toBudgetProgressDto } from '@/lib/ui/budget-view-model'
import { formatDate } from '@/lib/ui/format-date'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { BudgetCreateButton } from '@/components/budgets/budget-create-button'
import { BudgetProgressList } from '@/components/budgets/budget-progress-list'
import { BudgetRowActions } from '@/components/budgets/budget-row-actions'
import { MonthNav } from '@/components/budgets/month-nav'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'

/**
 * Budgets (spec §4.6, §5.5): one month's targets, each against its own
 * currency, never converted to `User.baseCurrency` (ledger ruling R5-3).
 *
 * The selected month lives in the URL, exactly like Reports' period filter —
 * `?month=yyyy-MM`, defaulting to the user's current local calendar month. A
 * malformed value, or a well-formed one outside the year `Budget.year` can
 * actually hold (`isBudgetableMonth`, `lib/datetime/calendar-month.ts`),
 * silently falls back rather than erroring: this is navigation, not a data
 * request the user typed by hand for its figures. Falling back matters for
 * more than cosmetics here — `BudgetForm` merges this month into every submit,
 * so an out-of-range year would render a create form whose every submission
 * `createBudgetSchema` rejects as `INVALID_INPUT`.
 */

/**
 * True when `month` is strictly earlier than `now`.
 *
 * What a past month gets is a note about its FX treatment, not a claim of
 * immutability: spec §5.5's "a closed month's percentage is permanently fixed"
 * is about the RATE — every contributing expense is summed at its own
 * `vndPerUsdAtEntry` (`lib/server/services/budget.ts`), so today's rate can
 * never move it. The row set is not fixed at all: the transaction form's date
 * field is unbounded, so a back-dated expense entered today still lands in
 * this month and changes its spend.
 */
function isPastMonth(month: CalendarMonth, now: CalendarMonth): boolean {
  return month.year < now.year || (month.year === now.year && month.month < now.month)
}

export default async function BudgetsPage({
  searchParams,
}: {
  // Query parameters as Next delivers them — untrusted, and never cast: a
  // repeated `?month=` key arrives as `string[]`, not `string` (see the same
  // convention in `app/(app)/reports/page.tsx`).
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything from the
  // query string — scopes both queries below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const now = new Date()
  const t = await getTranslations()
  const locale = await resolveLocale()

  const params = await searchParams
  const current = getCalendarMonth(timezone, now)
  // Only a `string` ever reaches the parser; anything else (`undefined`, a
  // repeated key's `string[]`) is treated as absent. A parsed month outside
  // the budgetable year range falls back exactly like a malformed one — see
  // the module doc above.
  const parsed = typeof params.month === 'string' ? parseCalendarMonth(params.month) : null
  const selected = parsed && isBudgetableMonth(parsed) ? parsed : current

  const [progress, categories] = await Promise.all([
    getBudgetProgressForMonth(user.id, timezone, selected.year, selected.month),
    listCategories(user.id, 'EXPENSE'),
  ])

  // The only place a `Decimal` becomes a string on this page. Every component
  // below renders `BudgetProgressDto`s; none receives a `Prisma.Decimal`.
  // Wrapped rather than passed bare: `Array#map` calls its callback with
  // `(element, index, array)`, and `toBudgetProgressDto` takes `locale` as a
  // second parameter — passed bare, `map`'s own index would land there.
  const dtos = progress.map((row) => toBudgetProgressDto(row, locale))
  const overallExists = dtos.some((dto) => dto.scope === 'OVERALL')

  // The month's own local start, formatted in the user's zone and locale.
  const monthLabel = formatDate(
    getCalendarMonthBounds(timezone, selected.year, selected.month).startUtc,
    { locale, timeZone: timezone, style: 'monthYear' },
  )

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('budgets.title')}
        description={monthLabel}
        meta={isPastMonth(selected, current) ? t('budgets.pastMonthNote') : undefined}
        actions={
          <>
            <MonthNav selected={selected} current={current} />
            <BudgetCreateButton
              key={`${selected.year}-${selected.month}`}
              year={selected.year}
              month={selected.month}
              categories={categories.map((c) => ({ id: c.id, name: c.name }))}
              overallExists={overallExists}
            />
          </>
        }
      />

      {dtos.length === 0 ? (
        <EmptyState
          icon={Target}
          size="page"
          title={t('budgets.emptyTitle', { month: monthLabel })}
          description={t('budgets.emptyBody')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="card-hover-effect overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
            <BudgetProgressList
              budgets={dtos}
              locale={locale}
              renderActions={(budget) => <BudgetRowActions budget={budget} />}
            />
          </div>
          {/* Only qualifies figures that are actually on screen — the empty
              state above has none for this note to explain. */}
          <p className="text-xs/[1rem] text-muted-foreground">{t('budgets.spendingNote')}</p>
        </div>
      )}
    </div>
  )
}
