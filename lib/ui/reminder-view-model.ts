import type { OccurrenceStatus, RecurrenceFrequency, ReminderType } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'
import { calendarDaysBetween, compareCalendarDates } from '@/lib/datetime/calendar-date'
import type { OccurrenceRow, ReminderRow } from '@/lib/server/services/reminder'
import { formatMoney } from './format-money'

/**
 * The Reminders page's DTO boundary, as three pure functions.
 *
 * `listUpcomingOccurrences` and `listReminders` return rows carrying
 * `Prisma.Decimal`s (`expectedAmount`) and `Date`s (`dueAt`, `startDate`,
 * `actionedAt`, `createdAt`); nothing downstream of this file may touch either,
 * because neither can cross the server-to-client-component boundary —
 * `OccurrenceActions` takes a whole `OccurrenceDto` and `ReminderToggle` reads
 * a `ReminderDto`. `lib/ui/reminder-view-model.test.ts` walks every leaf of
 * both DTOs and rejects anything that is not a primitive or `null`.
 *
 * Two rules are enforced here and nowhere else:
 *
 * 1. **Every instant is read in the USER's zone.** `dueAt` and `startDate` are
 *    instants of *local* midnight (`prisma/schema.prisma` says so on both
 *    columns), so `2026-04-14T17:00:00.000Z` is the 15th for a user in
 *    `Asia/Ho_Chi_Minh` and the 14th in UTC. `formatInTimeZone` with the
 *    profile's zone is therefore the only way either may be rendered — a
 *    `toISOString().slice(0, 10)` would tell a Vietnamese user their bill was
 *    due yesterday, and `formatCalendarDate` (which reads UTC components, for
 *    values that really are carriers) would do the same.
 * 2. **Amounts stay in the reminder's own currency.** No figure here is
 *    converted to `User.baseCurrency`, which is display-only (ledger ruling
 *    R5-3): a 20 USD subscription is 20 USD, and inventing a VND figure for it
 *    would be a fabricated FX conversion on a page that has no rate.
 *
 * A reminder is *not* a Transaction, so nothing in this file computes a
 * balance, a total or a running sum — an expected amount is what the user
 * thinks will move, not a record that it did.
 */

/** `yyyy-MM-dd` in the user's zone, the format both DTOs' date fields carry and
 *  `compareCalendarDates`/`calendarDaysBetween` both take. */
const CALENDAR_DATE_FORMAT = 'yyyy-MM-dd'

/**
 * Fixed English copy (Phase 7 replaces these literals with i18n keys, same as
 * `lib/ui/action-error-messages.ts`).
 *
 * "Bill" rather than "Expense", deliberately: EXPENSE is the ledger's word for
 * a transaction that has already been recorded, and the whole point of this
 * page is that nothing here has been. The user is being reminded of a bill they
 * still have to pay — and of income they are still waiting for.
 */
export const REMINDER_TYPE_LABELS: Record<ReminderType, 'Income' | 'Bill'> = {
  INCOME: 'Income',
  EXPENSE: 'Bill',
}

/**
 * How often the reminder recurs, in the user's words rather than the enum's.
 *
 * At interval 1 each cadence gets its own idiom — "Every week", "Monthly",
 * "Yearly" — because that is what a person says; "Every 1 month" reads like a
 * form field. Above 1 the count is named, which is the only way "every second
 * Tuesday's rent" is distinguishable from a weekly one.
 *
 * ONE_TIME ignores `interval` entirely. `createReminderSchema` refuses anything
 * but 1 on it and the service stores 1, so a stored row with another value
 * could only come from a write around both — and describing a one-off as
 * happening "every 3" of anything would be a schedule it does not have.
 */
export function recurrenceLabel(frequency: RecurrenceFrequency, interval: number): string {
  switch (frequency) {
    case 'ONE_TIME':
      return 'One time'
    case 'WEEKLY':
      return interval === 1 ? 'Every week' : `Every ${interval} weeks`
    case 'MONTHLY':
      return interval === 1 ? 'Monthly' : `Every ${interval} months`
    case 'YEARLY':
      return interval === 1 ? 'Yearly' : `Every ${interval} years`
  }
}

/**
 * What the row says about *when* this occurrence is due, relative to the user's
 * own today.
 *
 * "Overdue" carries no count of how late it is, on purpose: the list is
 * unbounded (an unanswered bill from January is still the user's to deal with),
 * and "Overdue by 97 days" would make the page shout at someone who already
 * knows. Marked, not shouted — `overdue` on the DTO is what the row styles on,
 * and the word is there so nothing depends on seeing colour.
 *
 * "Today" and "Tomorrow" are named rather than counted because that is how a
 * person reads a due date; from two days out the count is the useful form.
 */
function dueLabel(dueDate: string, today: string): string {
  const days = calendarDaysBetween(today, dueDate)
  if (days < 0) return 'Overdue'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `In ${days} days`
}

export interface OccurrenceDto {
  id: string
  /** The definition this instance came from — what a future "see this
   *  reminder's history" link is built from. */
  reminderId: string
  title: string
  type: ReminderType
  typeLabel: 'Income' | 'Bill'
  /** Formatted in the reminder's OWN currency, never converted. */
  amount: string
  currency: Currency
  /** `yyyy-MM-dd` — the due instant read as the day it falls on in the user's
   *  zone. */
  dueDate: string
  /** 'Overdue' | 'Today' | 'Tomorrow' | 'In n days'. */
  dueLabel: string
  /** Due before the user's today. The boolean the row styles on; `dueLabel`
   *  says the same thing in words. */
  overdue: boolean
  recurrenceLabel: string
  categoryName: string | null
  accountName: string | null
  /** PENDING for everything the upcoming list returns; the history view (and a
   *  row the user has just answered) can carry either of the other two. */
  status: OccurrenceStatus
}

export function toOccurrenceDto(
  row: OccurrenceRow,
  /** The user's IANA zone, from `resolveProfileDefaults(user).timezone` — never
   *  the server's, whose reading of `dueAt` is a different calendar day for
   *  every user east or west of it. */
  timezone: string,
  /** The user's own calendar day, from `todayCalendarDateInZone` — never
   *  `new Date()` here, for the reason `lib/datetime/calendar-date.ts` gives:
   *  this module has no user, and passing the day in is what makes every
   *  `dueLabel` case testable without freezing a clock. */
  today: string,
): OccurrenceDto {
  const { reminder } = row
  const currency = reminder.currency
  const dueDate = formatInTimeZone(row.dueAt, timezone, CALENDAR_DATE_FORMAT)

  return {
    id: row.id,
    reminderId: row.reminderId,
    title: reminder.title,
    type: reminder.type,
    typeLabel: REMINDER_TYPE_LABELS[reminder.type],
    amount: formatMoney(reminder.expectedAmount, currency),
    currency,
    dueDate,
    dueLabel: dueLabel(dueDate, today),
    // Compared as calendar strings, not instants: both sides are already days
    // in the user's zone, and re-deriving this from `dueAt` against `new Date()`
    // would be a second, drifting definition of "late".
    overdue: compareCalendarDates(dueDate, today) < 0,
    recurrenceLabel: recurrenceLabel(reminder.frequency, reminder.interval),
    // The names the service's own include already brought along — no follow-up
    // query per row, and none of the category's `userId`/`status` or the
    // account's `initialBalance` reaching a client component.
    categoryName: reminder.category?.name ?? null,
    accountName: reminder.account?.name ?? null,
    status: row.status,
  }
}

export interface ReminderDto {
  id: string
  title: string
  type: ReminderType
  typeLabel: 'Income' | 'Bill'
  /** Formatted in the reminder's OWN currency, never converted. */
  amount: string
  currency: Currency
  recurrenceLabel: string
  /** `yyyy-MM-dd` — the stored instant read as the day it falls on in the
   *  user's zone. */
  startDate: string
  /** False while paused: no NEW occurrences are materialized, and the ones it
   *  already has stay exactly as they are. */
  active: boolean
  note: string | null
  categoryName: string | null
  accountName: string | null
}

export function toReminderDto(row: ReminderRow, timezone: string): ReminderDto {
  const currency = row.currency

  return {
    id: row.id,
    title: row.title,
    type: row.type,
    typeLabel: REMINDER_TYPE_LABELS[row.type],
    amount: formatMoney(row.expectedAmount, currency),
    currency,
    recurrenceLabel: recurrenceLabel(row.frequency, row.interval),
    startDate: formatInTimeZone(row.startDate, timezone, CALENDAR_DATE_FORMAT),
    active: row.active,
    note: row.note,
    categoryName: row.category?.name ?? null,
    accountName: row.account?.name ?? null,
  }
}
