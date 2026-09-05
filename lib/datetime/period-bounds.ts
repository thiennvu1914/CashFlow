import {
  startOfDay,
  startOfWeek,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  addDays,
} from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year'

/**
 * Compute the [start, end) UTC bounds of the period containing `referenceDate`,
 * evaluated in the given IANA `timezone`.
 *
 * - `startUtc` is the instant the period begins, in UTC.
 * - `endUtc` is exclusive: the instant the *next* period begins, in UTC. Callers
 *   should filter with `>= startUtc && < endUtc`, never `<= endUtc`.
 * - `week` periods start on Monday (ISO week start), not Sunday.
 * - The calculation is timezone-aware, not a fixed UTC offset: `referenceDate`
 *   is projected into `timezone` before finding period boundaries, and the
 *   boundaries are converted back to UTC, so DST transitions in `timezone`
 *   are handled correctly.
 * - `timezone` must be a valid IANA zone name (e.g. `Asia/Ho_Chi_Minh`); an
 *   invalid zone throws from `date-fns-tz`, not from this function.
 */
export function getPeriodBounds(
  timezone: string,
  period: Period,
  referenceDate: Date,
): { startUtc: Date; endUtc: Date } {
  const zoned = toZonedTime(referenceDate, timezone)

  let startZoned: Date
  let nextStartZoned: Date

  switch (period) {
    case 'day':
      startZoned = startOfDay(zoned)
      nextStartZoned = startOfDay(addDays(zoned, 1))
      break
    case 'week':
      startZoned = startOfWeek(zoned, { weekStartsOn: 1 })
      nextStartZoned = addDays(startZoned, 7)
      break
    case 'month': {
      startZoned = startOfMonth(zoned)
      const next = new Date(startZoned)
      next.setMonth(next.getMonth() + 1)
      nextStartZoned = next
      break
    }
    case 'quarter': {
      startZoned = startOfQuarter(zoned)
      const next = new Date(startZoned)
      next.setMonth(next.getMonth() + 3)
      nextStartZoned = next
      break
    }
    case 'year': {
      startZoned = startOfYear(zoned)
      const next = new Date(startZoned)
      next.setFullYear(next.getFullYear() + 1)
      nextStartZoned = next
      break
    }
  }

  return {
    startUtc: fromZonedTime(startZoned, timezone),
    endUtc: fromZonedTime(nextStartZoned, timezone),
  }
}
