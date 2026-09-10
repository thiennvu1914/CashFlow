import { formatInTimeZone } from 'date-fns-tz'
import { isRealLocalDateTime } from './local-date-time'

/**
 * A calendar date with no time of day — what `<input type="date">` submits and
 * what a report's `from`/`to` query parameters carry.
 *
 * It is deliberately *not* an instant. `2026-03-31` is a different moment in
 * every timezone, so nothing here converts: turning one of these into a UTC
 * boundary is the caller's job, done with the user's zone (see
 * `lib/reports/report-range.ts`).
 *
 * ## Phase 6: storing a calendar date (ruling R6-7)
 *
 * Phase 6's planning dates — a savings goal's `deadline`, a debt's due date, a
 * loan's start and its payment dates — have no time of day at all. Unlike
 * `Transaction.date`, which is a real moment the user typed a clock time for
 * (`lib/datetime/local-date-time.ts`), "I want this saved by 31 March" names a
 * *day*, and it names the same day for every reader.
 *
 * Such a date is therefore stored as the **UTC midnight of that calendar day**
 * — a carrier, exactly like `lib/server/export/cells.ts`'s date cells: a `Date`
 * whose UTC components *are* the calendar date, and which is never re-projected
 * through anybody's timezone. `calendarDateToUtcCarrier` and
 * `formatCalendarDate` are the only two functions that cross that boundary, and
 * they are exact inverses, so a deadline round-trips through Postgres as the
 * same string the user picked in every zone on earth.
 *
 * That is why `deadline` is *not* run through `localDateTimeToInstant`: doing so
 * would shift 2026-03-31 to 2026-03-30T17:00Z for a user in
 * `Asia/Ho_Chi_Minh`, and the moment they changed their profile zone the same
 * stored row would read back as the 30th.
 *
 * Because a carrier is not an instant, "is this deadline in the past?" is never
 * an instant comparison either. It is a comparison of two calendar strings —
 * the stored one against `todayCalendarDateInZone(user.timezone)`, which is the
 * only place the user's zone enters. `compareCalendarDates` does that
 * comparison; nothing does date arithmetic on a carrier.
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

/**
 * `yyyy-MM-dd` → the UTC-midnight carrier for that calendar date.
 *
 * Throws a `RangeError` for anything `isRealCalendarDate` rejects, rather than
 * letting `new Date` roll `2026-02-30` over into 2 March: a stored deadline the
 * user never picked is worse than a failed write, and the two database CHECK
 * constraints cannot catch this one.
 */
export function calendarDateToUtcCarrier(value: string): Date {
  if (!isRealCalendarDate(value)) {
    throw new RangeError(`Expected a real yyyy-MM-dd calendar date, got ${JSON.stringify(value)}`)
  }
  // `Z`, never a bare `T00:00`: without it the string is parsed in the *server's*
  // zone, which would store a different day for a host running anywhere but UTC.
  return new Date(`${value}T00:00:00.000Z`)
}

/**
 * The inverse: a carrier's UTC components as `yyyy-MM-dd`.
 *
 * Read in UTC by construction (`toISOString` is defined on the UTC components),
 * so this is deliberately *not* `formatInTimeZone(carrier, timezone, …)` — a
 * carrier has no zone to be read in, and projecting one through the user's would
 * hand back the previous day for every zone west of UTC.
 */
export function formatCalendarDate(carrier: Date): string {
  return carrier.toISOString().slice(0, 10)
}

/**
 * Today's calendar date as it reads in `timezone` — the "now" every overdue
 * check compares against.
 *
 * Never `new Date().toISOString().slice(0, 10)`: between 00:00 and 07:00 in
 * `Asia/Ho_Chi_Minh` that answers yesterday, so a deadline of today would show
 * as still ahead — and in `America/Los_Angeles` it answers tomorrow after
 * 17:00, marking a deadline overdue a day early. `now` is injectable so the
 * pages that render "overdue" are deterministic under test.
 */
export function todayCalendarDateInZone(timezone: string, now: Date = new Date()): string {
  return formatInTimeZone(now, timezone, 'yyyy-MM-dd')
}

/**
 * Chronological order of two calendar dates as −1 / 0 / 1.
 *
 * A plain lexicographic string compare, which is exactly chronological here
 * because `yyyy-MM-dd` is fixed-width and zero-padded — no parsing, no `Date`,
 * no timezone. Compared as strings on purpose: the alternative (parsing both to
 * carriers) would reintroduce an instant into a question that has none.
 *
 * The shape is asserted rather than assumed: `'2026-3-1'` is not fixed-width, so
 * a lexicographic answer for it would be silently wrong (`'2026-3-1' > '2026-12-01'`).
 * Only the *shape* is checked, not `isRealCalendarDate` — ordering two days does
 * not require either of them to exist, and this runs once per rendered row.
 */
export function compareCalendarDates(a: string, b: string): -1 | 0 | 1 {
  for (const value of [a, b]) {
    if (!CALENDAR_DATE_RE.test(value)) {
      throw new RangeError(`Expected a yyyy-MM-dd calendar date, got ${JSON.stringify(value)}`)
    }
  }
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Milliseconds in a day — exact between two UTC-midnight carriers, where no
 *  DST shift can shorten one. Never applied to an instant. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * How many calendar days there are from `from` to `to`, both `yyyy-MM-dd`.
 *
 * Computed between two UTC-midnight carriers rather than from the instants the
 * dates came from, and that is the whole point: `(dueAt - now) / 86_400_000`
 * answers "0" for a bill due at midnight tomorrow when it is 09:00 today, and a
 * zone with a DST change makes a real three-day gap measure 71 hours. Carrier
 * arithmetic in UTC has neither problem — and `calendarDateToUtcCarrier` also
 * refuses a date that does not exist, so "31 April" cannot silently roll over.
 *
 * `Math.round` rather than a bare divide: both operands are exact multiples of
 * a day by construction, so this only guards against a future caller handing in
 * something that is not.
 */
export function calendarDaysBetween(from: string, to: string): number {
  const span = calendarDateToUtcCarrier(to).getTime() - calendarDateToUtcCarrier(from).getTime()
  return Math.round(span / MS_PER_DAY)
}
