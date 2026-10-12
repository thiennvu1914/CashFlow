import { advanceByFrequency, type PaymentFrequency } from '@/lib/datetime/add-months-clamped'
import {
  calendarDateToUtcCarrier,
  formatCalendarDate,
  isRealCalendarDate,
} from '@/lib/datetime/calendar-date'

/**
 * The first instalment's due date a new loan starts on: one period after the
 * start date. A loan that began today is not due today — its first instalment
 * is a week, month or year away — so the create form pre-fills this (and keeps
 * it in step with the start date and frequency until the user types their own).
 *
 * Calendar-date arithmetic on a UTC carrier, the same `advanceByFrequency` the
 * service advances the schedule with, so the default and every later due date
 * agree on how a month end clamps (Jan 31 → Feb 28).
 *
 * `null` for anything that is not a real `yyyy-MM-dd` day (the field is empty
 * while the user is typing), so the caller leaves the due date alone.
 */
export function defaultNextDueDate(startDate: string, frequency: PaymentFrequency): string | null {
  if (!isRealCalendarDate(startDate)) return null
  return formatCalendarDate(advanceByFrequency(calendarDateToUtcCarrier(startDate), frequency))
}
