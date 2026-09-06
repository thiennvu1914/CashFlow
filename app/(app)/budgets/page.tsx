import { formatInTimeZone } from 'date-fns-tz'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import {
  getCalendarMonth,
  getCalendarMonthBounds,
  isBudgetableMonth,
  parseCalendarMonth,
  type CalendarMonth,
} from '@/lib/datetime/calendar-month'
import { getBudgetProgressForMonth } from '@/lib/server/services/budget'
import { listCategories } from '@/lib/server/services/category'
import { toBudgetProgressDto } from '@/lib/ui/budget-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { BudgetForm } from '@/components/budgets/budget-form'
import { BudgetProgressList } from '@/components/budgets/budget-progress-list'
import { BudgetRowActions } from '@/components/budgets/budget-row-actions'
import { MonthNav } from '@/components/budgets/month-nav'

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
 * more than cosmetics here — an out-of-range year would otherwise render a
 * create form whose hidden `year` field `createBudgetSchema` always rejects,
 * so "Add budget" would submit and silently do nothing.
 */

/** True when `month` is strictly earlier than `now` — a closed month, whose
 *  figures are final because nothing can still post into it retroactively
 *  from the UI (spec's "closed month" framing). */
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
  const dtos = progress.map(toBudgetProgressDto)
  const overallExists = dtos.some((dto) => dto.scope === 'OVERALL')

  // The month's own local start, formatted in the user's zone — an honest
  // instant rather than a hand-built `Date.UTC`, which for a year below 100
  // hits JavaScript's legacy two-digit-year mapping (`Date.UTC(1, 0, 1)`
  // silently becomes 1901, not year 1) even though that year is now
  // unreachable here (`isBudgetableMonth` bounds it to 2000–2100).
  const monthLabel = formatInTimeZone(
    getCalendarMonthBounds(timezone, selected.year, selected.month).startUtc,
    timezone,
    'LLLL yyyy',
  )

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <div>
            <h1 className="text-xl font-semibold">Budgets</h1>
            <p className="text-sm text-muted-foreground">{monthLabel}</p>
          </div>
          <MonthNav selected={selected} current={current} />
        </div>

        {isPastMonth(selected, current) && (
          <p className="text-sm text-muted-foreground">Closed month — figures are final.</p>
        )}

        {dtos.length === 0 ? (
          <p className="text-sm text-foreground/60">No budgets for {monthLabel} — add one below.</p>
        ) : (
          <>
            <BudgetProgressList
              budgets={dtos}
              renderActions={(budget) => <BudgetRowActions budget={budget} />}
            />
            {/* Only qualifies figures that are actually on screen — the empty
                state above has none for this note to explain. */}
            <p className="text-xs text-muted-foreground">
              Spending counts expense transactions only, converted at each transaction&rsquo;s own
              recorded rate.
            </p>
          </>
        )}
      </div>

      <div id="new" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold">Add budget</h2>
        <BudgetForm
          year={selected.year}
          month={selected.month}
          categories={categories.map((category) => ({ id: category.id, name: category.name }))}
          overallExists={overallExists}
        />
      </div>
    </div>
  )
}
