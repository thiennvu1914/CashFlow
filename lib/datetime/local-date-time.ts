import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

/**
 * The local date-and-time convention for Transaction and Transfer `date`.
 *
 * A money movement happens at a moment, not on a day: "coffee at 09:15" and
 * "dinner at 18:45" are two different events on the same calendar day, and a
 * ledger that files both at midnight loses the order they actually happened in
 * — which is precisely the order the list is supposed to show. So the user
 * enters a date *and* a time (`<input type="datetime-local">`), and both are
 * preserved.
 *
 * A local date-time is not an instant until someone supplies a timezone, and
 * the browser is the wrong place to pick one: the client's zone is not
 * necessarily the user's configured zone. So the string travels as a string and
 * the **action layer** converts it, because only there is
 * `resolveProfileDefaults(user).timezone` known. Services keep taking real
 * instants and make no timezone assumption of their own; the database stores
 * UTC, and both lists render it back with `formatInTimeZone(date, timezone,
 * 'yyyy-MM-dd HH:mm')`.
 *
 * ## What "real" means, and why it is checked in UTC
 *
 * `2026-02-30T10:00` and `2026-09-05T24:00` both match the shape below and both
 * *roll over* if handed to a parser — into 2 March and the next midnight
 * respectively — storing a moment the user never entered. `isRealLocalDateTime`
 * rejects them by parsing as UTC and requiring the round trip to come back
 * identical.
 *
 * That reality check is deliberately timezone-independent, so Zod form schemas
 * can apply it before any timezone is known, and so a real DST gap is not
 * mistaken for a typo: in `America/New_York`, 2026-03-08T02:30 is a local time
 * that does not exist, and `fromZonedTime` resolves it forward to 03:30 the way
 * every calendar application does. Refusing that as "not a real date-time"
 * would reject an hour of the year the user can legitimately land on by
 * accident; accepting the forward-shifted instant is the honest reading of what
 * they meant.
 */

/** The exact shape an `<input type="datetime-local">` submits. Browsers omit
 *  `:ss` unless the input has a seconds step, so both are accepted. */
export const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/** `yyyy-MM-ddTHH:mm` (16 chars) with `:00` seconds appended when absent. */
function withSeconds(value: string): string {
  return value.length === 16 ? `${value}:00` : value
}

/**
 * True only for a `yyyy-MM-ddTHH:mm[:ss]` string that names a date-time that
 * exists.
 *
 * Timezone-independent (the check is done in UTC) — see the module comment.
 */
export function isRealLocalDateTime(value: string): boolean {
  if (!LOCAL_DATE_TIME_RE.test(value)) return false
  const normalised = withSeconds(value)
  const parsed = new Date(`${normalised}Z`)
  if (Number.isNaN(parsed.getTime())) return false
  // A rollover (2026-02-30, 24:00, 09:60) comes back as a different string.
  return parsed.toISOString().slice(0, 19) === normalised
}

/**
 * The instant that is `value` read as local wall-clock time in `timezone`.
 *
 * Rejects anything that is not a real local date-time; the shape check and the
 * reality check are both explicit here so a crafted request fails with a clear
 * message rather than silently landing on a different moment.
 */
export function localDateTimeToInstant(value: string, timezone: string): Date {
  if (!LOCAL_DATE_TIME_RE.test(value)) {
    throw new Error(`Expected a yyyy-MM-ddTHH:mm local date and time, got ${JSON.stringify(value)}`)
  }
  if (!isRealLocalDateTime(value)) {
    throw new Error(`${value} is not a real local date and time`)
  }
  const instant = fromZonedTime(withSeconds(value), timezone)
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`${value} is not a real local date and time`)
  }
  return instant
}

/**
 * The local date and time an instant falls on, in `timezone` — the inverse of
 * `localDateTimeToInstant`, and the value a `datetime-local` input expects.
 * Minute precision: seconds are not part of what the user enters.
 */
export function instantToLocalDateTime(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, "yyyy-MM-dd'T'HH:mm")
}

/**
 * Now, as a `datetime-local` value, in the given IANA `timezone` — the default
 * both entry forms pre-fill.
 *
 * Reading "now" in UTC (or in the browser's own zone) is wrong for any user
 * whose configured zone differs: between 00:00 and 07:00 in `Asia/Ho_Chi_Minh`
 * (UTC+7) a UTC clock pre-fills yesterday, and the wrong hour all day.
 *
 * `now` defaults to the real current instant; a fixed `Date` can be injected
 * for deterministic tests. `timezone` must be a valid IANA zone name — an
 * invalid one throws from `date-fns-tz`, not from this function.
 */
export function nowInZone(timezone: string, now: Date = new Date()): string {
  return instantToLocalDateTime(now, timezone)
}
