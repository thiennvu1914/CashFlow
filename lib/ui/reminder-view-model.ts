import type { OccurrenceStatus, RecurrenceFrequency, ReminderType } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'
import { calendarDaysBetween, compareCalendarDates } from '@/lib/datetime/calendar-date'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import type { OccurrenceRow, ReminderRow } from '@/lib/server/services/reminder'
import { formatMoney } from './format-money'

/**
 * The Reminders page's DTO boundary, as two pure functions.
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
 *
 * ## Phase 7: the DTOs return enums and a day count, not pre-baked English
 *
 * `OccurrenceDto`/`ReminderDto` used to carry ready-made English strings —
 * `typeLabel`, `recurrenceLabel`, `dueLabel` — which is exactly the kind of
 * literal Phase 7 is removing everywhere else (`lib/ui/action-error-
 * messages.ts` gives the same treatment to server-action errors). The type
 * and the recurrence are now returned as the enum values themselves, and the
 * component picks the message key: `reminderTypeLabelKey`/`recurrenceLabelKey`
 * (`lib/ui/labels.ts`) for the two label sets, a due-date key chosen from the
 * new `daysToDue` field for the third. `lib/ui/reminder-view-model.test.ts`
 * asserts neither DTO carries a `*Label` field or an English literal.
 *
 * `REMINDER_TYPE_LABELS` and `recurrenceLabel` below are NOT part of either
 * DTO and are not read by any UI component — they are kept exported only
 * because `lib/server/export/build-reminders-sheet.ts` (frozen this phase)
 * still imports them for the Excel export's `Type`/`Frequency` columns, which
 * are English regardless of the reader's locale (spec §12 says nothing about
 * localising a workbook). This is the same split `lib/ui/debt-view-model.ts`'s
 * `DEBT_STATUS_LABELS` and `lib/ui/loan-view-model.ts`'s
 * `LOAN_FREQUENCY_LABELS`/`LOAN_STATUS_LABELS` already make.
 */

/** `yyyy-MM-dd` in the user's zone, the format both DTOs' date fields carry and
 *  `compareCalendarDates`/`calendarDaysBetween` both take. */
const CALENDAR_DATE_FORMAT = 'yyyy-MM-dd'

/**
 * Fixed English copy, kept ONLY for `lib/server/export/build-reminders-
 * sheet.ts`'s export column — see the module doc above. No UI component reads
 * this: every renderer calls `reminderTypeLabelKey` instead.
 *
 * "Bill" rather than "Expense", deliberately: EXPENSE is the ledger's word for
 * a transaction that has already been recorded, and the whole point of this
 * page is that nothing here has been — the user is being reminded of a bill
 * they still have to pay, and of income they are still waiting for.
 */
export const REMINDER_TYPE_LABELS: Record<ReminderType, 'Income' | 'Bill'> = {
  INCOME: 'Income',
  EXPENSE: 'Bill',
}

/**
 * Fixed English copy for the export's `Frequency` column — see the module
 * doc above. No UI component reads this: every renderer calls
 * `recurrenceLabelKey` instead.
 *
 * At interval 1 each cadence gets its own idiom — "Every week", "Monthly",
 * "Yearly" — because that is what a person says; "Every 1 month" reads like a
 * form field. Above 1 the count is named. ONE_TIME ignores `interval`
 * entirely: `createReminderSchema` refuses anything but 1 on it and the
 * service stores 1, so a stored row with another value could only come from a
 * write around both, and describing a one-off as happening "every 3" of
 * anything would be a schedule it does not have.
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

export interface OccurrenceDto {
  id: string
  /** The definition this instance came from — what a future "see this
   *  reminder's history" link is built from, and what `clusterByReminder`
   *  (`components/reminders/occurrence-group.tsx`) groups on. */
  reminderId: string
  title: string
  type: ReminderType
  /** How often the reminder that produced this occurrence recurs — the
   *  component reads it through `recurrenceLabelKey(frequency, interval)`. */
  frequency: RecurrenceFrequency
  interval: number
  /** Formatted in the reminder's OWN currency, never converted. */
  amount: string
  currency: Currency
  /** `yyyy-MM-dd` — the due instant read as the day it falls on in the user's
   *  zone. */
  dueDate: string
  /**
   * Whole calendar days from the user's own today to `dueDate`; negative when
   * overdue, computed with `calendarDaysBetween` (never milliseconds — see
   * that function's own doc for why a DST change or a month boundary would
   * make a millisecond count wrong).
   *
   * The component picks one of four message keys from it —
   * `reminders.overdue`/`dueToday`/`dueTomorrow`/`dueInDays` — rather than
   * this module baking English into a `dueLabel` string, which is what it did
   * before Phase 7. Two of the four cases carry the same reasoning the old
   * `dueLabel` doc comment did: "Overdue" carries no count of how late it is,
   * on purpose — the list is unbounded (an unanswered bill from January is
   * still the user's to deal with), and "Overdue by 97 days" would make the
   * page shout at someone who already knows. "Today"/"Tomorrow" are named
   * rather than counted because that is how a person reads a due date; from
   * two days out the count is the useful form.
   */
  daysToDue: number
  /** Due before the user's today. The boolean the row styles on; the due-key
   *  the component picks says the same thing in words. */
  overdue: boolean
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
   *  `daysToDue` case testable without freezing a clock. */
  today: string,
  /** The reader's locale, for `formatMoney`'s grouping — defaults to `vi` so
   *  every pre-Phase-7 caller keeps working untouched. */
  locale: Locale = DEFAULT_LOCALE,
): OccurrenceDto {
  const { reminder } = row
  const currency = reminder.currency
  const dueDate = formatInTimeZone(row.dueAt, timezone, CALENDAR_DATE_FORMAT)

  return {
    id: row.id,
    reminderId: row.reminderId,
    title: reminder.title,
    type: reminder.type,
    frequency: reminder.frequency,
    interval: reminder.interval,
    amount: formatMoney(reminder.expectedAmount, currency, locale),
    currency,
    dueDate,
    daysToDue: calendarDaysBetween(today, dueDate),
    // Compared as calendar strings, not instants: both sides are already days
    // in the user's zone, and re-deriving this from `dueAt` against `new Date()`
    // would be a second, drifting definition of "late". This stays the single
    // definition of "overdue" — it is NOT re-derived from `daysToDue < 0`,
    // which agrees with it only by construction (both come from the same pair
    // of calendar strings); a future change to one must not silently change
    // the other's meaning.
    overdue: compareCalendarDates(dueDate, today) < 0,
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
  /** How often this reminder recurs — the component reads it through
   *  `recurrenceLabelKey(frequency, interval)`. */
  frequency: RecurrenceFrequency
  interval: number
  /** Formatted in the reminder's OWN currency, never converted. */
  amount: string
  currency: Currency
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

export function toReminderDto(
  row: ReminderRow,
  timezone: string,
  /** The reader's locale, for `formatMoney`'s grouping — defaults to `vi` so
   *  every pre-Phase-7 caller keeps working untouched. */
  locale: Locale = DEFAULT_LOCALE,
): ReminderDto {
  const currency = row.currency

  return {
    id: row.id,
    title: row.title,
    type: row.type,
    frequency: row.frequency,
    interval: row.interval,
    amount: formatMoney(row.expectedAmount, currency, locale),
    currency,
    startDate: formatInTimeZone(row.startDate, timezone, CALENDAR_DATE_FORMAT),
    active: row.active,
    note: row.note,
    categoryName: row.category?.name ?? null,
    accountName: row.account?.name ?? null,
  }
}
