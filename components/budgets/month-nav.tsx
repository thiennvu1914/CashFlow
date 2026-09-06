import Link from 'next/link'
import { cn } from 'cn'
import {
  addCalendarMonths,
  formatCalendarMonth,
  type CalendarMonth,
} from '@/lib/datetime/calendar-month'

/**
 * The Budgets page's month picker, with the month itself kept in the URL —
 * the same "the address bar is the source of truth" treatment as
 * `components/reports/period-filter.tsx`. A server component with no state:
 * "Previous"/"This month"/"Next" are ordinary links to `/budgets?month=yyyy-MM`.
 */
export function MonthNav({
  selected,
  current,
}: {
  selected: CalendarMonth
  /** The user's actual current local month — what "This month" links to and
   *  what decides its `aria-current`. */
  current: CalendarMonth
}) {
  const previous = addCalendarMonths(selected, -1)
  const next = addCalendarMonths(selected, 1)
  const isCurrent = selected.year === current.year && selected.month === current.month

  function linkClass(active: boolean) {
    return cn(
      'rounded-md px-2.5 py-1.5 text-sm',
      active
        ? 'bg-muted font-medium text-brand'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    )
  }

  return (
    <nav aria-label="Budget month" className="flex flex-wrap gap-1">
      <Link href={`/budgets?month=${formatCalendarMonth(previous)}`} className={linkClass(false)}>
        ‹ Previous
      </Link>
      <Link
        href={`/budgets?month=${formatCalendarMonth(current)}`}
        aria-current={isCurrent ? 'page' : undefined}
        className={linkClass(isCurrent)}
      >
        This month
      </Link>
      <Link href={`/budgets?month=${formatCalendarMonth(next)}`} className={linkClass(false)}>
        Next ›
      </Link>
    </nav>
  )
}
