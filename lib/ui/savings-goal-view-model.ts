import { Prisma } from '@prisma/client'
import type { SavingsGoalStatus } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import {
  calendarDaysBetween,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import type { SavingsGoalRow } from '@/lib/server/services/savings-goal'
import { formatMoney, formatPercent } from './format-money'

/**
 * The Savings page's DTO boundary, as one pure function.
 *
 * `listSavingsGoals` returns rows carrying `Prisma.Decimal`s and a `Date`;
 * nothing downstream of this file may touch either, because neither can cross
 * the server-to-client-component boundary (`GoalRowActions` and the edit form
 * are client components). `percent` is the one `toNumber()` in this DTO — a
 * progress-bar width has to be a plain number — and `percentLabel` is rounded
 * on the `Decimal` itself, before that widening, so the label and the bar can
 * never read two different roundings of the same ratio.
 *
 * A goal is never converted to `User.baseCurrency` here or anywhere else
 * (ledger ruling R5-3): `target`/`progress`/`remaining` are formatted in the
 * goal's own `currency`, full stop. Two goals in two currencies are two
 * targets, never a sum.
 *
 * `today` is passed in rather than read here, for the reason
 * `lib/datetime/calendar-date.ts` gives: the user's zone is what decides which
 * calendar day "now" is, and this module has no user. It is also what makes
 * every "overdue" case testable without freezing a clock.
 *
 * No status copy is baked in here at all (Phase 7): this module returns the
 * `SavingsGoalStatus` enum and the component that renders a row translates it
 * via `goalStatusLabelKey` — this stays a pure function with no translator of
 * its own.
 */
export interface SavingsGoalDto {
  id: string
  name: string
  currency: Currency
  status: SavingsGoalStatus
  target: string
  progress: string
  /** How much is still to go — `max(0, target − progress)`, never negative:
   *  over-saving leaves nothing remaining rather than a "−200.000" to read. */
  remaining: string
  /** Bar fill 0–100, clamped; the one `toNumber()` for this DTO. */
  percent: number
  /** e.g. "120 %" — whole percent, half-up on the `Decimal`, and deliberately
   *  NOT clamped: the bar's width may not overflow, the figure may. A
   *  NON-BREAKING space before the sign (fix round 1, finding 7) stops the
   *  figure wrapping away from its own "%" at 375. */
  percentLabel: string
  /** The stored carrier as the calendar date the user picked, or `null`. */
  deadline: string | null
  /** The deadline is behind us and the goal is still unmet. An ACHIEVED goal is
   *  never late — saved after the date is still saved. */
  deadlinePassed: boolean
  /** Whole calendar days from the user's today to the deadline; negative when
   *  it has passed, `null` when the goal has none. Computed here, on the same
   *  UTC-midnight carrier arithmetic the rest of this module uses, so the
   *  component does no date maths and the ICU plural in `goals.deadlineMeta`
   *  gets a plain number. */
  daysToDeadline: number | null
  /** Prefill for the inline edit and progress forms. Strings only — a
   *  `Prisma.Decimal` cannot cross to a client component, and `''` is what an
   *  empty `<input>` needs (the schema reads it back as "no value"). */
  editable: {
    name: string
    /** `toFixed(2)`, so the number input round-trips the stored scale. */
    targetAmount: string
    currency: Currency
    /** `yyyy-MM-dd` for `<input type="date">`; `''` when the goal has none. */
    deadline: string
    note: string
    currentProgress: string
  }
}

/**
 * Fixed English copy for each stored status, kept ONLY because
 * `lib/server/export/build-savings-goals-sheet.ts` (frozen this phase) still
 * imports it for the Excel export's `Status` column, which is English
 * regardless of the reader's locale (spec §12 says nothing about localising a
 * workbook, and Phase 7's own export sheets are out of scope). No UI component
 * reads this: `toSavingsGoalDto` below returns the bare `status` enum, and
 * every renderer calls `goalStatusLabelKey` instead.
 */
export const SAVINGS_GOAL_STATUS_LABELS: Record<SavingsGoalStatus, string> = {
  ACTIVE: 'In progress',
  ACHIEVED: 'Achieved',
  ARCHIVED: 'Archived',
}

/** The bar can fill the track, never overflow it. */
const MAX_PERCENT = 100

export function toSavingsGoalDto(
  goal: SavingsGoalRow,
  today: string,
  locale: Locale = DEFAULT_LOCALE,
): SavingsGoalDto {
  const currency = goal.currency
  const target = goal.targetAmount
  const progress = goal.currentProgress

  const shortfall = target.sub(progress)
  const remaining = shortfall.isNegative() ? new Prisma.Decimal(0) : shortfall
  // Safe without a zero guard: `SavingsGoal_targetAmount_positive` (the CHECK
  // in this model's migration) and `createSavingsGoalSchema` both forbid a
  // target of zero, so there is no stored row this could divide by.
  const ratio = progress.div(target)

  const deadline = goal.deadline === null ? null : formatCalendarDate(goal.deadline)

  return {
    id: goal.id,
    name: goal.name,
    currency,
    status: goal.status,
    target: formatMoney(target, currency, locale),
    progress: formatMoney(progress, currency, locale),
    remaining: formatMoney(remaining, currency, locale),
    percent: Math.min(MAX_PERCENT, ratio.mul(100).toNumber()),
    // Rounded on the `Decimal` first (unchanged rounding semantics);
    // `formatPercent` only formats that already-rounded whole number for the
    // reader's locale and appends the sign -- it does no rounding of its own.
    percentLabel: formatPercent(
      ratio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
      locale,
    ),
    deadline,
    // A string compare, not an instant one — `compareCalendarDates` documents
    // why. `=== -1` so a deadline of *today* is not yet missed.
    deadlinePassed:
      deadline !== null &&
      goal.status !== 'ACHIEVED' &&
      compareCalendarDates(deadline, today) === -1,
    daysToDeadline: deadline === null ? null : calendarDaysBetween(today, deadline),
    editable: {
      name: goal.name,
      targetAmount: target.toFixed(2),
      currency,
      deadline: deadline ?? '',
      note: goal.note ?? '',
      currentProgress: progress.toFixed(2),
    },
  }
}
