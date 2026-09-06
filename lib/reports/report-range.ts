import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { isRealCalendarDate } from '@/lib/datetime/calendar-date'
import { getPeriodBounds, type Period } from '@/lib/datetime/period-bounds'

/**
 * The one place a URL becomes a report's UTC range.
 *
 * Both the Reports page and the export route (Task 7) resolve their range here,
 * from the same query parameters — which is what guarantees a filtered export
 * covers exactly the window the page was showing, custom dates and all, rather
 * than re-deriving "this month" a second time and disagreeing at a boundary.
 *
 * Everything it reads is attacker-controlled, so nothing is trusted: a period
 * is checked against `PERIODS` before it is ever treated as a `Period` (a bare
 * cast would let `?period=__proto__` through), a repeated parameter — which
 * Next hands over as an array — is refused rather than silently resolved to its
 * first value, and a date must be both the right shape and a day that exists.
 *
 * ## Inclusive `to`, exclusive `endUtc`
 *
 * "1 Mar – 31 Mar" means the whole of 31 March to the person reading it, so the
 * internal upper bound is the *exclusive* start of the following local day —
 * the same `date >= startUtc AND date < endUtc` convention `getPeriodBounds`
 * and every service query already use. The bound is computed as local midnight
 * of the next calendar day rather than by adding 24 hours, so a DST transition
 * between `to` and the day after it cannot shift it by an hour.
 */

/** The named periods a report may be asked for. `custom` is handled separately. */
export const PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const

/** What a report shows when the URL says nothing. */
const DEFAULT_PERIOD: Period = 'month'

/** The literal the custom from/to mode is selected by. */
export const CUSTOM_PERIOD = 'custom'

export class InvalidReportRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReportRangeError'
  }
}

export type ReportRange =
  | { kind: Period; startUtc: Date; endUtc: Date }
  | { kind: typeof CUSTOM_PERIOD; from: string; to: string; startUtc: Date; endUtc: Date }

/**
 * One raw query parameter as Next's `searchParams` delivers it: absent, a
 * single value, or an array when the key was repeated in the URL.
 */
type RawParam = string | string[] | undefined

export interface ReportRangeParams {
  period?: RawParam
  from?: RawParam
  to?: RawParam
}

function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value)
}

/**
 * The single value of a query parameter.
 *
 * A repeated key (`?period=day&period=year`) arrives as an array, and quietly
 * picking one of them would let a crafted URL show a range that disagrees with
 * the one the page's own links round-trip. There is no honest answer, so this
 * refuses.
 */
function single(value: RawParam, name: string): string | undefined {
  if (Array.isArray(value)) {
    throw new InvalidReportRangeError(`The ${name} parameter was given more than once`)
  }
  return value
}

/** A `yyyy-MM-dd` parameter, or a thrown error naming the offending field. */
function requireCalendarDate(value: string | undefined, name: string): string {
  if (value === undefined || !isRealCalendarDate(value)) {
    throw new InvalidReportRangeError(
      `${name} must be a real calendar date in YYYY-MM-DD format (got ${JSON.stringify(value ?? null)})`,
    )
  }
  return value
}

/** The instant a calendar date begins in `timezone`. */
function localMidnightUtc(dateOnly: string, timezone: string): Date {
  return fromZonedTime(`${dateOnly}T00:00:00`, timezone)
}

/**
 * The calendar date after `dateOnly`, still as `yyyy-MM-dd`.
 *
 * Computed in UTC purely as calendar arithmetic — `Date.UTC` normalises the day
 * overflow (31 Mar + 1 → 1 Apr, 31 Dec + 1 → 1 Jan) — so no timezone or DST
 * rule is involved in naming the day; the zone is applied afterwards, when that
 * day's midnight is resolved.
 */
function nextCalendarDay(dateOnly: string): string {
  // Safe to destructure: the caller has already proven the shape and reality.
  const [year, month, day] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

/**
 * The validated UTC window a set of query parameters asks for, evaluated in the
 * user's `timezone`. `now` is injectable so a page renders every figure against
 * one instant and tests are deterministic.
 *
 * Throws `InvalidReportRangeError` — and nothing else — for any input a user
 * could have typed or forged; the Reports page catches exactly that and renders
 * a message instead of a 500.
 */
export function resolveReportRange(
  params: ReportRangeParams,
  timezone: string,
  now: Date = new Date(),
): ReportRange {
  // `??`, not `||`: an explicit `?period=` is a wrong answer to reject, not a
  // missing one to default.
  const period = single(params.period, 'period') ?? DEFAULT_PERIOD

  if (period === CUSTOM_PERIOD) {
    const from = requireCalendarDate(single(params.from, 'from'), 'from')
    const to = requireCalendarDate(single(params.to, 'to'), 'to')
    // Compared as strings: both are `yyyy-MM-dd`, whose lexicographic order is
    // its chronological order, so the check needs no timezone at all and cannot
    // be confused by one date's offset differing from the other's.
    if (from > to) {
      throw new InvalidReportRangeError(`from (${from}) must be on or before to (${to})`)
    }
    return {
      kind: CUSTOM_PERIOD,
      from,
      to,
      startUtc: localMidnightUtc(from, timezone),
      endUtc: localMidnightUtc(nextCalendarDay(to), timezone),
    }
  }

  if (!isPeriod(period)) {
    throw new InvalidReportRangeError(
      `Unknown period ${JSON.stringify(period)} — expected one of ${PERIODS.join(', ')} or custom`,
    )
  }
  const { startUtc, endUtc } = getPeriodBounds(timezone, period, now)
  return { kind: period, startUtc, endUtc }
}

/**
 * The range as query parameters — the inverse of `resolveReportRange`, and the
 * only way an export link is built. A named period is re-sent as the period
 * itself rather than as resolved dates, so a bookmarked "this month" still
 * means this month.
 */
export function rangeToQueryString(range: ReportRange): string {
  const query = new URLSearchParams()
  query.set('period', range.kind)
  if (range.kind === CUSTOM_PERIOD) {
    query.set('from', range.from)
    query.set('to', range.to)
  }
  return query.toString()
}

export interface ReportRangeLabels {
  /** `yyyy-MM-dd`, the first day the range covers, in the user's zone. */
  fromLabel: string
  /** `yyyy-MM-dd`, the last day it covers — *not* the exclusive bound. */
  toLabelInclusive: string
}

/**
 * The range as the user reads it: two inclusive local calendar days.
 *
 * `endUtc` is exclusive, so showing it directly would name the day *after* the
 * one the report covers ("1 Mar – 1 Apr" for March). The last included instant
 * is one millisecond earlier, and that instant's local date is the honest
 * label.
 */
export function describeRange(range: ReportRange, timezone: string): ReportRangeLabels {
  return {
    fromLabel: formatInTimeZone(range.startUtc, timezone, 'yyyy-MM-dd'),
    toLabelInclusive: formatInTimeZone(
      new Date(range.endUtc.getTime() - 1),
      timezone,
      'yyyy-MM-dd',
    ),
  }
}
