import { formatInTimeZone } from 'date-fns-tz'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import {
  getCalendarMonth,
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
 * malformed value silently falls back rather than erroring: this is
 * navigation, not a data request the user typed by hand for its figures.
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
  searchParams: Promise<{ month?: string }>
}) {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything from the
  // query string — scopes both queries below.
  const user = await requireUserOrRedirect()
  const { timezone } = resolveProfileDefaults(user)
  const now = new Date()

  const { month } = await searchParams
  const current = getCalendarMonth(timezone, now)
  const selected = (month ? parseCalendarMonth(month) : null) ?? current

  const [progress, categories] = await Promise.all([
    getBudgetProgressForMonth(user.id, timezone, selected.year, selected.month),
    listCategories(user.id, 'EXPENSE'),
  ])

  // The only place a `Decimal` becomes a string on this page. Every component
  // below renders `BudgetProgressDto`s; none receives a `Prisma.Decimal`.
  const dtos = progress.map(toBudgetProgressDto)
  const overallExists = dtos.some((dto) => dto.scope === 'OVERALL')

  // A label, not an instant: any date inside the month works, formatted in
  // 'UTC' so the month it names never shifts with the reader's zone.
  const monthLabel = formatInTimeZone(
    new Date(Date.UTC(selected.year, selected.month - 1, 1)),
    'UTC',
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
          <BudgetProgressList
            budgets={dtos}
            renderActions={(budget) => <BudgetRowActions budget={budget} />}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Spending counts expense transactions only, converted at each transaction&rsquo;s own
          recorded rate.
        </p>
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
