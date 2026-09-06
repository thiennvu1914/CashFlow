import { subMonths } from 'date-fns'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'
import { getPeriodBounds } from './period-bounds'

/**
 * The trailing run of calendar months every "last N months" chart is built on
 * (spec §5.5, §5.6).
 *
 * The months are the *user's* local ones, not UTC ones: `now` is projected into
 * `timezone`, stepped back with `subMonths` on that local wall clock, and each
 * step converted back to an instant before `getPeriodBounds` re-projects it —
 * so for `Asia/Ho_Chi_Minh` a window boundary is 17:00Z on the last day of the
 * preceding UTC month, not midnight UTC. Stepping on the local clock is also
 * what keeps the sequence correct across a year boundary and immune to a `now`
 * that falls in a different UTC month than the local one.
 *
 * Shared by the cash-flow trend (which buckets rows into these windows) and by
 * the balance-over-time chart (which samples a balance at the end of each), so
 * the two charts on the dashboard can never disagree about which months they
 * are showing or where a month begins.
 */
export interface MonthWindow {
  /** `yyyy-MM` as the month reads in `timezone`. */
  month: string
  startUtc: Date
  /** Exclusive, matching `getPeriodBounds` — the first instant of the next month. */
  endUtc: Date
}

/**
 * The `monthsBack` calendar months ending with the one containing `now`, oldest
 * first. Returns `[]` for a non-positive `monthsBack` rather than inventing a
 * window.
 */
export function getRecentMonthWindows(
  timezone: string,
  monthsBack: number,
  now: Date = new Date(),
): MonthWindow[] {
  if (monthsBack < 1) return []

  const nowZoned = toZonedTime(now, timezone)
  const windows: MonthWindow[] = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    // A day-of-month that does not exist in the earlier month is clamped by
    // date-fns, which still lands in the intended month — only the month
    // matters here.
    const reference = fromZonedTime(subMonths(nowZoned, i), timezone)
    const bounds = getPeriodBounds(timezone, 'month', reference)
    windows.push({ month: formatInTimeZone(bounds.startUtc, timezone, 'yyyy-MM'), ...bounds })
  }
  return windows
}
