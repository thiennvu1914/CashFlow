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
 * Confirm the installed date-fns-tz major version exposes `fromZonedTime`/`toZonedTime`
 * (v3 naming). If the installed version is v2, use `zonedTimeToUtc`/`utcToZonedTime` instead —
 * check `node_modules/date-fns-tz/package.json` before assuming either name.
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
