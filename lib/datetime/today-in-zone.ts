import { formatInTimeZone } from 'date-fns-tz'

/**
 * Today's date, as `yyyy-MM-dd`, in the given IANA `timezone` — the format an
 * `<input type="date">` requires as its default value.
 *
 * `new Date().toISOString().slice(0, 10)` (the pattern this replaces) reads
 * "today" in UTC, which is wrong for any user west of UTC in the evening or
 * east of UTC overnight: between 00:00 and 07:00 in `Asia/Ho_Chi_Minh`
 * (UTC+7), for instance, it silently pre-fills *yesterday*.
 *
 * `now` defaults to the real current instant; a fixed `Date` can be injected
 * for deterministic tests. `timezone` must be a valid IANA zone name — an
 * invalid one throws from `date-fns-tz`, not from this function.
 */
export function todayInZone(timezone: string, now: Date = new Date()): string {
  return formatInTimeZone(now, timezone, 'yyyy-MM-dd')
}
