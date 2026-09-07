import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { getPeriodBounds } from './period-bounds'

/**
 * A named calendar month — the identity a Budget carries (spec §4.6).
 *
 * A budget's month is `year` + `month` integers, deliberately not a `DateTime`:
 * "March 2026" is the same fact in every timezone, so storing it needs no zone
 * at all. Only the *query* that sums that month's transactions needs one, and
 * `getCalendarMonthBounds` is the single place that turns a named month into the
 * half-open UTC window `[startUtc, endUtc)` such a query filters on.
 *
 * Every function here delegates its zone arithmetic to `getPeriodBounds` /
 * `date-fns-tz`. Nothing in this module reads a server-local `Date` getter
 * (`getMonth`, `getFullYear`, …): those answer in whatever zone the process
 * happens to run in, which for a user in `Asia/Ho_Chi_Minh` served from a UTC
 * host is the wrong month for seven hours of every day.
 */
export interface CalendarMonth {
  year: number
  /** 1–12, i.e. human month numbers, not JavaScript's 0-based ones. */
  month: number
}

/** `yyyy-MM`, the only string form of a `CalendarMonth` this app uses. */
const CALENDAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function assertMonth(year: number, month: number): void {
  if (!Number.isInteger(year)) throw new RangeError(`Calendar year must be an integer, got ${year}`)
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Calendar month must be an integer 1–12, got ${month}`)
  }
}

/**
 * `[startUtc, endUtc)` of the local calendar month `year-month` in `timezone`.
 * `endUtc` is exclusive — the first instant of the following month — matching
 * `getPeriodBounds` and every range query in the app.
 *
 * The reference instant is built at **noon on the 15th** of the month rather
 * than its first midnight. `new Date(Date.UTC(year, month - 1, 1))` looks
 * simpler but is wrong for every zone west of UTC: for `America/Los_Angeles`
 * that instant reads as the last day of the *previous* month locally, so
 * `getPeriodBounds` would return the wrong month entirely. Mid-month noon is at
 * least ~14 days and ~12 hours away from either boundary, which no real UTC
 * offset (max ±14h) or DST shift can cross.
 */
export function getCalendarMonthBounds(
  timezone: string,
  year: number,
  month: number,
): { startUtc: Date; endUtc: Date } {
  assertMonth(year, month)
  const reference = fromZonedTime(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-15T12:00:00`,
    timezone,
  )
  return getPeriodBounds(timezone, 'month', reference)
}

/**
 * The calendar month containing `instant` as it reads in `timezone` — so
 * `2026-03-31T17:30:00Z` is April for a user in `Asia/Ho_Chi_Minh`, where it is
 * already 00:30 on 1 April.
 */
export function getCalendarMonth(timezone: string, instant: Date): CalendarMonth {
  return {
    year: Number(formatInTimeZone(instant, timezone, 'yyyy')),
    month: Number(formatInTimeZone(instant, timezone, 'MM')),
  }
}

/** `{ year: 2026, month: 3 }` → `"2026-03"`. */
export function formatCalendarMonth(m: CalendarMonth): string {
  assertMonth(m.year, m.month)
  return `${String(m.year).padStart(4, '0')}-${String(m.month).padStart(2, '0')}`
}

/**
 * `"2026-03"` → `{ year: 2026, month: 3 }`, and `null` for anything else.
 *
 * Returns `null` rather than throwing because the callers are parsing untrusted
 * input — a URL search param, a form field — where a bad value is a routine
 * "fall back to the current month", not an exceptional condition.
 */
export function parseCalendarMonth(value: string): CalendarMonth | null {
  if (!CALENDAR_MONTH_RE.test(value)) return null
  const [year, month] = value.split('-')
  return { year: Number(year), month: Number(month) }
}

/**
 * `m` shifted by `delta` months, wrapping the year — the month-picker's
 * previous/next step. Pure integer arithmetic on the (year, month) pair, so no
 * timezone and no `Date` is involved: the answer is the same everywhere.
 */
export function addCalendarMonths(m: CalendarMonth, delta: number): CalendarMonth {
  assertMonth(m.year, m.month)
  if (!Number.isInteger(delta)) {
    throw new RangeError(`Month delta must be an integer, got ${delta}`)
  }
  // Work in 0-based months so a negative `delta` floors correctly across a year
  // boundary; `Math.floor` (not a truncating division) is what makes
  // `{2026,1}` minus one month land on December 2025 rather than January 2026.
  const zeroBased = m.year * 12 + (m.month - 1) + delta
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 }
}

/**
 * The inclusive year range a Budget can actually be created for.
 *
 * This bound is application-level: `createBudgetSchema` (`lib/validation/budget.ts`)
 * and `isBudgetableMonth` below are the only things enforcing it — the database
 * has no year CHECK (`Budget_month_range` constrains `month` alone, so a direct
 * insert with `year = 99999` is accepted). Defined here, once, and imported by
 * the validation schema rather than restated as a second literal `2000`/`2100`
 * pair, so the two cannot drift apart.
 */
export const MIN_BUDGET_YEAR = 2000
export const MAX_BUDGET_YEAR = 2100

/**
 * Whether `month` falls inside the year range a Budget can be created for.
 * `parseCalendarMonth` accepts any 4-digit year — it only knows "well-formed
 * `yyyy-MM`", not "budgetable" — so a page that lets the user navigate to an
 * arbitrary month must apply this on top before trusting the result, exactly
 * as it already treats a regex failure: an out-of-range year is as malformed
 * as `?month=banana`, not a legitimate month whose form simply cannot submit.
 */
export function isBudgetableMonth(month: CalendarMonth): boolean {
  return month.year >= MIN_BUDGET_YEAR && month.year <= MAX_BUDGET_YEAR
}
