import { getTranslations } from 'next-intl/server'
import {
  MAX_BUDGET_YEAR,
  MIN_BUDGET_YEAR,
  addCalendarMonths,
  formatCalendarMonth,
  type CalendarMonth,
} from '@/lib/datetime/calendar-month'
import { SegmentedControl, type Segment } from '@/components/common/segmented-control'

/**
 * The Budgets page's month picker, with the month itself kept in the URL —
 * the same "the address bar is the source of truth" treatment as
 * `components/reports/period-filter.tsx`. An async server component with no
 * state: "Previous"/"This month"/"Next" are ordinary links to
 * `/budgets?month=yyyy-MM`, rendered through the shared `SegmentedControl`.
 *
 * "Previous" is disabled at `MIN_BUDGET_YEAR`-01 and "Next" at
 * `MAX_BUDGET_YEAR`-12 — the ends of the range `Budget.year` can actually
 * hold — so this component can never link the page outside the range the
 * create form would then silently reject (see `app/(app)/budgets/page.tsx`).
 */
export async function MonthNav({
  selected,
  current,
}: {
  selected: CalendarMonth
  /** The user's actual current local month — what "This month" links to and
   *  what decides its `aria-current`. */
  current: CalendarMonth
}) {
  const t = await getTranslations()
  const previous = addCalendarMonths(selected, -1)
  const next = addCalendarMonths(selected, 1)
  const isCurrent = selected.year === current.year && selected.month === current.month
  const atMinYear = selected.year === MIN_BUDGET_YEAR && selected.month === 1
  const atMaxYear = selected.year === MAX_BUDGET_YEAR && selected.month === 12

  const segments: Segment[] = [
    // At the ends of the range the unavailable move is OMITTED rather than
    // rendered disabled — a segmented control with a dead segment invites a
    // click that does nothing, where `SegmentedControl` has no `disabled`
    // concept at all (every segment it renders is a live link).
    ...(atMinYear
      ? []
      : [
          {
            id: 'previous',
            label: t('budgets.monthPrevious'),
            href: `/budgets?month=${formatCalendarMonth(previous)}`,
          },
        ]),
    {
      id: 'current',
      label: t('budgets.monthCurrent'),
      href: `/budgets?month=${formatCalendarMonth(current)}`,
    },
    ...(atMaxYear
      ? []
      : [
          {
            id: 'next',
            label: t('budgets.monthNext'),
            href: `/budgets?month=${formatCalendarMonth(next)}`,
          },
        ]),
  ]

  return (
    <SegmentedControl
      label={t('budgets.monthNav')}
      segments={segments}
      // Only "Tháng này" can be the SELECTED segment: previous/next are moves,
      // not states, and marking one of them current would claim the user is
      // "in" a relative month.
      activeId={isCurrent ? 'current' : null}
    />
  )
}
