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

/**
 * The anchor day (`dueDayOfMonth`) the create form sends with the loan.
 *
 * While the next due date is the pre-filled one (one period after the start
 * date), the anchor is the START date's day: a loan started on the 31st is
 * first due on Feb 28, and anchoring on that clamped 28 would pin the schedule
 * to the 28th for ever (Feb 28 → Mar 28), silently changing the user's due day.
 * Once the user types a due date of their own, the anchor is that date's day —
 * what they typed is what they meant, as it always was.
 */
export function scheduleAnchorDay(
  startDate: string,
  nextDueDate: string,
  nextDueTyped: boolean,
): number {
  return Number((nextDueTyped ? nextDueDate : startDate).slice(8, 10))
}
