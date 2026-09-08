/**
 * Calendar-safe month arithmetic for a repayment schedule (spec §4.10).
 *
 * A loan's `nextDueDate` is a calendar-date carrier (UTC midnight, ruling R6-7)
 * that has to move one instalment forward every time a payment is recorded, and
 * both obvious ways of doing that are wrong:
 *
 * - **`setUTCMonth(m + 1)`** overflows. 31 January plus one month becomes
 *   "31 February", which JavaScript rolls over into 3 March — a due date the
 *   user never agreed to, silently, for one loan in twelve.
 * - **`+30 days`** (or `+ 30 * 86_400_000`) is not a month at all. It walks the
 *   due date backwards through the calendar — the 31st, the 30th, the 29th… —
 *   until a loan that is due at the end of every month is due in the middle of
 *   one.
 *
 * Clamping the day to the target month's length fixes the overflow but, on its
 * own, still loses the schedule permanently: Jan 31 → Feb 28 → **Mar 28**, and
 * from then on every instalment is three days early. So the *agreed* day of the
 * month travels separately, as `anchorDay` — the `Loan.dueDayOfMonth` column
 * (ruling R6-6a) — and each step is computed from the anchor rather than from
 * the previous, possibly clamped, result. That gives the sequence a bank
 * statement actually shows: Jan 31 → Feb 28 → Mar 31 → Apr 30 → May 31.
 *
 * Everything here is pure and UTC-only. There is no `date-fns-tz` import and no
 * timezone parameter, deliberately: these functions operate on carriers, whose
 * UTC components *are* the calendar date (`lib/datetime/calendar-date.ts`), so
 * projecting one through anybody's zone would be the bug, not the fix. Local
 * getters (`getMonth`, `getDate`) never appear for the same reason.
 */

/** Milliseconds in a day — exact in UTC, where no DST shift can shorten one. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Days in the given UTC month (`monthIndex` 0–11, JavaScript's own numbering).
 *
 * Day 0 of the *following* month is the last day of this one, which is how the
 * leap-year rules (including the /100 and /400 cases a hand-rolled
 * `year % 4 === 0` gets wrong) come from the engine's own calendar rather than
 * from arithmetic written here.
 *
 * The month index is asserted rather than allowed to roll over: `daysInUtcMonth(2026, 12)`
 * would quietly answer for January 2027, and a wrong month length is exactly
 * the kind of off-by-one that produces a due date nobody can explain.
 */
export function daysInUtcMonth(year: number, monthIndex: number): number {
  if (!Number.isInteger(year)) {
    throw new RangeError(`Expected an integer year, got ${year}`)
  }
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new RangeError(`Expected a month index 0–11, got ${monthIndex}`)
  }
  const probe = new Date(0)
  // `setUTCFullYear(year, month, day)` rather than `Date.UTC(...)`: the latter
  // maps a year of 0–99 onto 1900–1999, so a two-digit year would answer for
  // the wrong century.
  probe.setUTCFullYear(year, monthIndex + 1, 0)
  return probe.getUTCDate()
}

/**
 * Adds `months` whole months to a UTC-midnight calendar-date carrier, landing on
 * `anchorDay` (defaults to the carrier's own day) clamped to the target month's
 * length. Time of day is preserved (a carrier's is 00:00Z).
 *
 * `anchorDay` is what keeps a month-end schedule from decaying: pass the loan's
 * `dueDayOfMonth` and 28 February plus one month is 31 March, not 28 March.
 * Omit it and the function is the plain clamped addition, which is what a
 * one-off shift wants.
 *
 * Negative `months` walks backwards, and does so correctly across a year
 * boundary because the month total is floored rather than truncated.
 *
 * The input is never mutated — a new `Date` is always returned, so a caller
 * cannot accidentally alter the `Loan` row's own `nextDueDate` instance.
 */
export function addMonthsUtcClamped(date: Date, months: number, anchorDay?: number): Date {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Expected a valid Date')
  }
  if (!Number.isInteger(months)) {
    throw new RangeError(`Expected a whole number of months, got ${months}`)
  }
  if (
    anchorDay !== undefined &&
    (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)
  ) {
    throw new RangeError(`Expected an anchor day 1–31, got ${anchorDay}`)
  }

  const totalMonths = date.getUTCMonth() + months
  // `Math.floor`, not a truncating division: for `totalMonths = -1` (January
  // minus one month) the year has to step back, and `-1 / 12 | 0` is 0.
  const year = date.getUTCFullYear() + Math.floor(totalMonths / 12)
  const monthIndex = ((totalMonths % 12) + 12) % 12
  // The clamp: the anchor (or the carrier's own day) capped at what the target
  // month actually has, so "31 February" can never be constructed and roll over.
  const day = Math.min(anchorDay ?? date.getUTCDate(), daysInUtcMonth(year, monthIndex))

  const result = new Date(0)
  // All three components set in one call, on a date that is already the 1st, so
  // there is no intermediate "31 February" to overflow; and `setUTCFullYear`
  // rather than `Date.UTC` for the two-digit-year reason above.
  result.setUTCFullYear(year, monthIndex, day)
  result.setUTCHours(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
  return result
}

/**
 * A loan's payment cadence — kept in step with the Prisma `PaymentFrequency`
 * enum by hand, exactly as `lib/validation/*.ts` mirrors the other enums, so
 * this module stays free of a Prisma import and can be used from anywhere.
 * A divergence fails `tsc` at the service's call site rather than at runtime.
 */
export type PaymentFrequency = 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/**
 * One instalment forward. WEEKLY: +7 days. MONTHLY: +1 month at `anchorDay`.
 * YEARLY: +12 months at `anchorDay`.
 *
 * WEEKLY ignores `anchorDay` because a weekly schedule has no day of the month
 * to hold on to — "every Friday" is what it means, and adding 7 days to a UTC
 * carrier preserves the weekday exactly (no DST exists in UTC, so the
 * millisecond arithmetic cannot land 23 or 25 hours out the way it would in a
 * local zone).
 */
export function advanceByFrequency(
  date: Date,
  frequency: PaymentFrequency,
  anchorDay?: number,
): Date {
  switch (frequency) {
    case 'WEEKLY':
      if (Number.isNaN(date.getTime())) throw new RangeError('Expected a valid Date')
      return new Date(date.getTime() + 7 * MS_PER_DAY)
    case 'MONTHLY':
      return addMonthsUtcClamped(date, 1, anchorDay)
    case 'YEARLY':
      return addMonthsUtcClamped(date, 12, anchorDay)
  }
}
