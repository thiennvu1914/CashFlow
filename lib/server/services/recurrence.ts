import { addMonthsUtcClamped } from '@/lib/datetime/add-months-clamped'

/**
 * Recurrence date computation for reminders (spec §4.7) — pure, and deliberately
 * timezone-blind.
 *
 * ## What a `Date` means in this module
 *
 * Every `Date` in and out of here is a **local calendar date carrier**: a
 * UTC-midnight `Date` whose UTC year/month/day *are* the day the user would
 * point at on a wall calendar (`lib/datetime/calendar-date.ts`, ruling R6-7).
 * Nothing here imports `date-fns-tz`, takes a timezone parameter, or calls a
 * local getter (`getMonth`, `getDate`) — the service converts at its edges
 * (`toLocalCalendarCarrier` / `localCarrierToInstant` in
 * `lib/server/services/reminder.ts`) and this module only ever does calendar
 * arithmetic on the three UTC components.
 *
 * That split is what makes "rent is due on the 1st" mean *the 1st where the user
 * lives*. A recurrence engine that stepped instants instead would be wrong twice
 * over: adding 7 × 86,400,000 ms across a DST boundary lands an hour out (so a
 * weekly reminder drifts to 23:00 the previous day and then reads as the wrong
 * calendar day), and "one month later" has no millisecond definition at all.
 * Doing the arithmetic on carriers and converting once, at the edge, has neither
 * problem — and it is also why every test in `recurrence.test.ts` is
 * deterministic whatever `TZ` the host is set to.
 *
 * ## The anchor, and why the clamp is not enough on its own
 *
 * A monthly reminder on the 31st cannot fall on the 31st of February, so the day
 * is clamped to the target month's length. Clamping alone, however, loses the
 * schedule permanently: Jan 31 → Feb 28 → **Mar 28**, and from then on the
 * reminder is three days early for good. So each date is computed from a fixed
 * *anchor* — `dayOfMonth`, or the day of `startDate` when the user did not name
 * one — rather than from the previous, possibly clamped, result. That gives the
 * sequence a bill actually follows: Jan 31 → Feb 28 → Mar 31 → Apr 30.
 *
 * The clamp and the anchor both live in `lib/datetime/add-months-clamped.ts`
 * (`addMonthsUtcClamped`, itself built on `daysInUtcMonth`), which is Group 4's
 * loan-schedule arithmetic — reused rather than reimplemented, so a reminder on
 * the 31st and a loan instalment on the 31st can never disagree about which day
 * February's is.
 *
 * ## ONE_TIME is not a recurrence
 *
 * It is one date — `startDate` — surfaced if the window contains it, and it is
 * never stepped, never anchored and never clamped. `dayOfMonth` and `month` are
 * ignored for it outright, so a stray anchor left over from an edit cannot move
 * the day the user picked. `oneIntervalBefore` returns its input unchanged for
 * ONE_TIME for the matching reason: the service must not clamp a one-time
 * reminder's backfill window at all, or an overdue one would silently vanish
 * (directive O).
 *
 * ## Cost: proportional to the answer, not to the calendar
 *
 * Both stepping loops **seek** to the window's start arithmetically before they
 * begin (`seekToWindow`), so producing six dates in 2026 costs six iterations
 * whether the reminder started last month or in 1800. Walking every step from
 * `startDate` instead — the obvious implementation — makes the work
 * proportional to *elapsed time*, which is not merely slow: it trips
 * `MAX_ITERATIONS` for a start date only 191 years back on a weekly rule, and
 * that `RangeError` propagates out through `materializeDueOccurrences` and
 * `listUpcomingOccurrences` and breaks every render of the reminders page and
 * the dashboard widget, permanently, for a value `<input type="date">` will
 * happily submit.
 *
 * Every occurrence is still computed from the *original* phase — `startMs` for
 * WEEKLY, the phase month for MONTHLY/YEARLY — never by accumulating onto the
 * previous result, so seeking thousands of steps cannot shift the weekday or
 * decay the anchor. `recurrence.test.ts` proves that against a brute-force
 * day-by-day scan.
 */

/** Milliseconds in a day — exact in UTC, where no DST shift can shorten one. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The hard stop on either stepping loop below.
 *
 * Because both loops *seek* to the window before they start (see
 * `seekToWindow`), the number of iterations is now the number of dates the
 * caller asked for plus at most two — so this bound is reached only by
 * requesting a genuinely enormous *range*, never by an old `startDate`. It stays
 * because "the loop cannot run away" should be a property of the code rather
 * than of its inputs, and because a corrupt `startDate` or `to` read from a
 * database column must fail loudly instead of filling a request's memory with
 * `Date` allocations.
 *
 * It emphatically must **not** be reachable by an old start date, which is what
 * it was before the seek: the WEEKLY loop stepped from `startDate`, so a
 * reminder started in 1800 needed 11,806 steps to reach a six-date window in
 * 2026 and threw — out through `materializeDueOccurrences` and
 * `listUpcomingOccurrences`, breaking every render of the reminders page and the
 * dashboard widget, permanently. Nothing bounds `startDate`
 * (`calendarDateStringSchema` checks shape and reality only), so the fix had to
 * be in the arithmetic, not in a wider cap.
 */
const MAX_ITERATIONS = 10_000

/**
 * How often a reminder recurs. Kept in step with the Prisma
 * `RecurrenceFrequency` enum by hand, exactly as `lib/validation/*.ts` mirrors
 * the other enums, so this module stays free of a Prisma import; a divergence
 * fails `tsc` at the service's call site rather than at runtime.
 */
export type RecurrenceFrequency = 'ONE_TIME' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RecurrenceRule {
  frequency: RecurrenceFrequency
  /** How many periods between occurrences; `>= 1`. */
  interval: number
  /** The anchor day, 1–31, clamped down to each target month's length. MONTHLY
   *  and YEARLY only; defaults to `startDate`'s own day. Ignored otherwise. */
  dayOfMonth?: number
  /** The anchor month, **1–12** (not JavaScript's 0–11). YEARLY only; defaults
   *  to `startDate`'s own month. Ignored otherwise — a MONTHLY rule takes its
   *  phase from `startDate`, since every month is a candidate. */
  month?: number
  /** The first day the reminder can fall on, as a local calendar date carrier.
   *  No returned date is ever before it. */
  startDate: Date
}

/** A local calendar date carrier for the given UTC components.
 *
 *  `setUTCFullYear` rather than `Date.UTC`, for the reason
 *  `add-months-clamped.ts` documents: the latter maps a year of 0–99 onto
 *  1900–1999, so a two-digit year would silently answer for the wrong century. */
function utcCarrier(year: number, monthIndex: number, day: number): Date {
  const carrier = new Date(0)
  carrier.setUTCFullYear(year, monthIndex, day)
  return carrier
}

function assertValidCarrier(date: Date, label: string): void {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Expected a valid ${label} date carrier`)
  }
}

/**
 * `interval >= 1`, whole.
 *
 * A RangeError rather than a silent coercion to 1: an interval of 0 is a
 * non-terminating loop for every frequency but ONE_TIME, and one of 1.5 is not a
 * schedule anybody can read off a calendar. Zod
 * (`lib/validation/reminder.ts`) and the `RecurringReminder_interval_min` CHECK
 * both refuse these first, so reaching here means a caller bypassed both — which
 * must fail rather than produce dates.
 */
function assertInterval(interval: number): void {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(`Expected a whole recurrence interval of at least 1, got ${interval}`)
  }
}

/**
 * The step index to start a stepping loop at: an index provably *at or before*
 * the first occurrence inside the window.
 *
 * This is what makes both loops below cost O(dates returned) instead of
 * O(time since `startDate`). `distance` is how far the window's start lies from
 * the rule's phase, and `stride` how far one step moves — both in the same unit
 * (milliseconds for WEEKLY, whole months for MONTHLY/YEARLY), and both exact
 * integers well inside `Number.MAX_SAFE_INTEGER`.
 *
 * It deliberately **under**-estimates by one step rather than trying to land
 * exactly on the first occurrence, for two independent reasons:
 *
 * 1. *Correctness by construction.* Whether `Math.floor` of a float division
 *    lands on the true quotient at these magnitudes is an argument about ulps;
 *    whether the loop's own `occurrence >= fromMs` filter drops a date before
 *    the window is not an argument at all. Starting early and letting the
 *    existing filter decide where the window begins means the seek cannot skip
 *    an occurrence even if the division were off by one.
 * 2. *The month case needs it anyway.* A monthly rule's step lands on a day
 *    *within* a month, so the step whose month contains `from` can still fall
 *    before `from` — an anchor of the 1st with a window starting on the 15th.
 *    That candidate has to be generated and rejected, not seeked past.
 *
 * The cost is at most two wasted iterations, against thousands saved.
 */
function seekToWindow(distance: number, stride: number): number {
  return Math.max(0, Math.floor(distance / stride) - 1)
}

/**
 * Every due date of `rule` with `from <= date <= to` (inclusive, both local
 * calendar date carriers), never before `rule.startDate`, ascending.
 *
 * Both bounds are inclusive because both are meaningful days rather than
 * boundaries: `from` is the first day the caller wants to see and `to` is the
 * last, so a reminder due on either must appear. (`getPeriodBounds`'s exclusive
 * `endUtc` is the opposite convention for the opposite reason — it bounds an
 * instant range, where the end is a boundary and not a day.)
 *
 * An inverted range (`to < from`) is an empty result, not an error: the service
 * builds `from` from a `max(...)` of two dates, and a reminder whose `startDate`
 * is beyond the lookahead window legitimately has nothing due yet.
 */
export function computeDueDates(rule: RecurrenceRule, from: Date, to: Date): Date[] {
  assertInterval(rule.interval)
  assertValidCarrier(rule.startDate, 'startDate')
  assertValidCarrier(from, 'from')
  assertValidCarrier(to, 'to')
  if (rule.dayOfMonth !== undefined) {
    if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
      throw new RangeError(`Expected a dayOfMonth of 1–31, got ${rule.dayOfMonth}`)
    }
  }
  if (rule.month !== undefined) {
    if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) {
      throw new RangeError(`Expected a month of 1–12, got ${rule.month}`)
    }
  }

  if (to.getTime() < from.getTime()) return []

  const startMs = rule.startDate.getTime()
  const fromMs = Math.max(from.getTime(), startMs)
  const toMs = to.getTime()

  // ONE_TIME: the day the user picked, or nothing. No stepping, no anchor, no
  // clamp — see the module comment.
  if (rule.frequency === 'ONE_TIME') {
    if (startMs < fromMs || startMs > toMs) return []
    // A copy, so a caller cannot mutate the rule's own `startDate` (which in the
    // service is the `RecurringReminder` row's column) through the result.
    return [new Date(startMs)]
  }

  const dates: Date[] = []

  if (rule.frequency === 'WEEKLY') {
    // A fixed multiple of whole days from `startDate`, which preserves the
    // weekday exactly: "every other Monday" stays a Monday, because a carrier is
    // UTC and no DST shift can make one of these days 23 or 25 hours long.
    const stepMs = 7 * rule.interval * MS_PER_DAY
    // Seek rather than walk: jump straight to the last step at or before the
    // window instead of stepping through every week since `startDate`. Each
    // occurrence is then computed from `startMs` afresh — never by accumulating
    // onto the previous one — so the phase (and therefore the weekday) is exact
    // however many thousands of steps were skipped.
    const firstStep = seekToWindow(fromMs - startMs, stepMs)
    for (let iteration = 0; ; iteration += 1) {
      if (iteration >= MAX_ITERATIONS) {
        throw new RangeError(`Recurrence would need more than ${MAX_ITERATIONS} iterations`)
      }
      const occurrenceMs = startMs + (firstStep + iteration) * stepMs
      if (occurrenceMs > toMs) break
      if (occurrenceMs >= fromMs) dates.push(new Date(occurrenceMs))
    }
    return dates
  }

  // MONTHLY and YEARLY are the same walk at two step sizes: whole months from a
  // fixed (year, month) phase, landing on the anchor day clamped to the target
  // month's length.
  const stepMonths = rule.frequency === 'YEARLY' ? 12 * rule.interval : rule.interval
  const anchorDay = rule.dayOfMonth ?? rule.startDate.getUTCDate()
  // YEARLY may be anchored to a month other than `startDate`'s ("every 25
  // December", started in June). MONTHLY has no such choice to make — every
  // month is a candidate — so it takes its phase from `startDate` and ignores
  // `month` entirely.
  const anchorMonthIndex =
    rule.frequency === 'YEARLY' && rule.month !== undefined
      ? rule.month - 1
      : rule.startDate.getUTCMonth()
  // Day 1 of the phase month: a date that cannot itself overflow, so every step
  // below is one clamped addition rather than an addition on an already-clamped
  // result — which is what stops the schedule decaying (module comment).
  const phase = utcCarrier(rule.startDate.getUTCFullYear(), anchorMonthIndex, 1)

  // The same seek as WEEKLY, measured in whole months: how many months lie
  // between the phase month and the month the window starts in, divided by the
  // stride. Both are small exact integers, so this is plain integer arithmetic
  // — and it is congruent to the original phase by construction, so a quarterly
  // rule anchored in February stays on February/May/August/November however far
  // the seek jumped.
  const windowStart = new Date(fromMs)
  const monthsToWindow =
    (windowStart.getUTCFullYear() - phase.getUTCFullYear()) * 12 +
    (windowStart.getUTCMonth() - phase.getUTCMonth())
  const firstStep = seekToWindow(monthsToWindow, stepMonths)

  for (let iteration = 0; ; iteration += 1) {
    if (iteration >= MAX_ITERATIONS) {
      throw new RangeError(`Recurrence would need more than ${MAX_ITERATIONS} iterations`)
    }
    // `daysInUtcMonth` is what does the clamp, one level down inside
    // `addMonthsUtcClamped` — the same function Group 4's loan schedule uses, so
    // a reminder and an instalment can never disagree about February's length.
    // Always computed from `phase`, never from the previous result, so the
    // anchor cannot decay however large the step index is.
    const occurrence = addMonthsUtcClamped(phase, (firstStep + iteration) * stepMonths, anchorDay)
    const occurrenceMs = occurrence.getTime()
    if (occurrenceMs > toMs) break
    // The first candidate can precede `startDate` — an anchor of the 1st on a
    // reminder started on the 20th, or a December anchor on one started in June
    // — and such a date is dropped rather than surfaced as an occurrence from
    // before the reminder existed.
    if (occurrenceMs >= fromMs) dates.push(occurrence)
  }

  return dates
}

/**
 * `from` minus exactly one interval of `rule`, as a local calendar date carrier
 * — the lower bound of the service's backfill window.
 *
 * Backfilling from one interval back rather than from `startDate` is what stops
 * the first read of a years-old monthly reminder flooding the user with dozens
 * of overdue rows they never saw (spec §4.7): one interval is enough to surface
 * the occurrence they may genuinely have missed, and no more.
 *
 * **ONE_TIME returns `from` unchanged**, and callers must not clamp a ONE_TIME
 * reminder at all (directive O): it has at most one occurrence ever, so there is
 * no flood to guard against, and clamping it would hide exactly the reminder the
 * user most needs — the one-off payment they are already late for.
 *
 * MONTHLY and YEARLY steps are clamped to the target month's length, so
 * "one month before 31 March" is 28 February (29 February in a leap year) rather
 * than a rolled-over 3 March that would widen the window by three days.
 */
export function oneIntervalBefore(
  rule: Pick<RecurrenceRule, 'frequency' | 'interval'>,
  from: Date,
): Date {
  assertInterval(rule.interval)
  assertValidCarrier(from, 'from')

  switch (rule.frequency) {
    case 'ONE_TIME':
      // A copy rather than `from` itself, so the identity holds without handing
      // the caller a second reference to its own input to mutate.
      return new Date(from.getTime())
    case 'WEEKLY':
      return new Date(from.getTime() - 7 * rule.interval * MS_PER_DAY)
    case 'MONTHLY':
      // No `anchorDay`: this is a one-off shift of a window bound, not a step in
      // a schedule, so the plain clamped subtraction is what is wanted.
      return addMonthsUtcClamped(from, -rule.interval)
    case 'YEARLY':
      return addMonthsUtcClamped(from, -12 * rule.interval)
  }
}
