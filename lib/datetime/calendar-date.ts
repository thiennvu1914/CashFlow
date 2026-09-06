import { isRealLocalDateTime } from './local-date-time'

/**
 * A calendar date with no time of day — what `<input type="date">` submits and
 * what a report's `from`/`to` query parameters carry.
 *
 * It is deliberately *not* an instant. `2026-03-31` is a different moment in
 * every timezone, so nothing here converts: turning one of these into a UTC
 * boundary is the caller's job, done with the user's zone (see
 * `lib/reports/report-range.ts`).
 */

/** The exact shape an `<input type="date">` submits, anchored at both ends. */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * True only for a `yyyy-MM-dd` string naming a day that exists.
 *
 * The reality check matters as much as the shape check: `2026-02-30` matches
 * the pattern and *rolls over* into 2 March if handed to a parser, so a report
 * would silently cover a range the user never asked for. This is the
 * date-only sibling of `isRealLocalDateTime`, and delegates to it at local
 * midnight so both share one definition of "real" — timezone-independent, done
 * in UTC, rejecting anything whose round trip comes back as a different string.
 */
export function isRealCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_RE.test(value)) return false
  return isRealLocalDateTime(`${value}T00:00`)
}
