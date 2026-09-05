import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

/**
 * The calendar-date convention (ruling R-21b).
 *
 * A Transaction's or Transfer's `date` is a *calendar day*, not a moment: the
 * user picks "5 September" in an `<input type="date">`, and nothing in the UI
 * ever shows a time of day. It is stored as a `DateTime` all the same, so the
 * two representations have to be pinned to each other explicitly or the day
 * drifts:
 *
 * - storing `new Date('2026-09-05')` puts the row at UTC midnight, which is
 *   still 4 September for every zone behind UTC — the list then renders
 *   "2026-09-04" for the day the user typed, and Phase 3's period math (which
 *   runs `getPeriodBounds` in the user's zone) files it in the wrong month at
 *   the boundary;
 * - storing "whatever `new Date()` happened to be" carries a time of day the
 *   user never entered.
 *
 * So the convention is: **the stored instant is local midnight of the user's
 * calendar day, in their IANA timezone at the moment of entry**. Reading it
 * back with `formatInTimeZone(instant, timezone, 'yyyy-MM-dd')` — which is
 * what both lists already do — returns exactly the day the user picked, and
 * `getPeriodBounds` in the same zone brackets it correctly.
 *
 * The conversion belongs to the *action* layer: only there is the session
 * user's timezone known (`resolveProfileDefaults(user).timezone`). Forms
 * submit the plain `yyyy-MM-dd` string; services keep taking real instants and
 * make no timezone assumption of their own.
 */

/** The exact shape an `<input type="date">` submits. */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * True only for a `yyyy-MM-dd` string that names a day that exists.
 *
 * Timezone-independent (the check is done in UTC), so Zod form schemas can use
 * it before any timezone is known: `2026-02-30` and `2026-13-40` match the
 * regex but are rejected here, which keeps a crafted request from reaching
 * `calendarDateToInstant` and surfacing as an unmapped server error.
 */
export function isRealCalendarDate(date: string): boolean {
  if (!CALENDAR_DATE_RE.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

/**
 * The instant that is local midnight of `date` in `timezone`.
 *
 * Rejects anything that is not a real calendar day. The regex alone is not
 * enough — `2026-13-40` and `2026-02-30` both match it, and `date-fns-tz`
 * would silently roll them forward into a different day — so the result is
 * read back in the same zone and must agree with the input.
 */
export function calendarDateToInstant(date: string, timezone: string): Date {
  if (!CALENDAR_DATE_RE.test(date)) {
    throw new Error(`Expected a yyyy-MM-dd calendar date, got ${JSON.stringify(date)}`)
  }
  const instant = fromZonedTime(`${date}T00:00:00`, timezone)
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`${date} is not a real calendar date`)
  }
  if (instantToCalendarDate(instant, timezone) !== date) {
    throw new Error(`${date} is not a real calendar date`)
  }
  return instant
}

/**
 * The calendar day an instant falls on, in `timezone` — the inverse of
 * `calendarDateToInstant`, and the same formatting the transaction and
 * transfer lists already use for display.
 */
export function instantToCalendarDate(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, 'yyyy-MM-dd')
}
