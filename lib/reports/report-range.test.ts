import { describe, expect, it } from 'vitest'
import {
  InvalidReportRangeError,
  PERIODS,
  describeRange,
  offendingReportRangeParam,
  rangeToQueryString,
  resolveReportRange,
  type ReportRangeParams,
} from './report-range'

/**
 * The resolver is the *only* place a URL becomes a UTC range, so these tests
 * are as much about what it refuses as about what it computes: everything here
 * arrives from `searchParams`, which is attacker-controlled.
 */

const TZ = 'Asia/Ho_Chi_Minh'
const NY = 'America/New_York'
/** A Sunday, 17:00 local in `TZ`. Fixed, so every named period below is exact. */
const NOW = new Date('2026-03-15T10:00:00Z')

describe('resolveReportRange — named periods', () => {
  it('defaults to month when no period is given', () => {
    const r = resolveReportRange({}, TZ, NOW)
    expect(r.kind).toBe('month')
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it.each([
    // `now` is Sunday 15 March 17:00 in Ho Chi Minh City (UTC+7).
    ['day', '2026-03-14T17:00:00.000Z', '2026-03-15T17:00:00.000Z'],
    // Monday-start weeks: the week containing Sunday 15 March is 9–15 March.
    ['week', '2026-03-08T17:00:00.000Z', '2026-03-15T17:00:00.000Z'],
    ['month', '2026-02-28T17:00:00.000Z', '2026-03-31T17:00:00.000Z'],
    ['quarter', '2025-12-31T17:00:00.000Z', '2026-03-31T17:00:00.000Z'],
    ['year', '2025-12-31T17:00:00.000Z', '2026-12-31T17:00:00.000Z'],
  ])('resolves %s against a fixed now, in the user timezone', (period, startUtc, endUtc) => {
    const r = resolveReportRange({ period }, TZ, NOW)
    expect(r.kind).toBe(period)
    expect(r.startUtc.toISOString()).toBe(startUtc)
    expect(r.endUtc.toISOString()).toBe(endUtc)
  })

  it('offers exactly the named periods the UI may link to', () => {
    expect([...PERIODS]).toEqual(['day', 'week', 'month', 'quarter', 'year'])
  })

  it.each(['weekly', 'MONTH', '__proto__', 'custom;drop', '', 'constructor', 'toString'])(
    'rejects an unknown period %j',
    (p) => {
      expect(() => resolveReportRange({ period: p }, TZ, NOW)).toThrow(InvalidReportRangeError)
    },
  )

  it('ignores from/to for a named period rather than half-honouring them', () => {
    const r = resolveReportRange({ period: 'month', from: 'garbage', to: '2026-03-31' }, TZ, NOW)
    expect(r.kind).toBe('month')
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(rangeToQueryString(r)).toBe('period=month')
  })
})

describe('resolveReportRange — repeated query parameters', () => {
  // Next hands a repeated key (`?period=day&period=year`) through as an array.
  // Silently taking the first or last would let a crafted URL disagree with the
  // range the page believes it is showing.
  const repeated: [string, ReportRangeParams][] = [
    ['period', { period: ['day', 'year'] }],
    ['from', { period: 'custom', from: ['2026-03-01', '2026-01-01'], to: '2026-03-31' }],
    ['to', { period: 'custom', from: '2026-03-01', to: ['2026-03-31', '2026-04-30'] }],
  ]

  it.each(repeated)('rejects a repeated %s parameter', (_name, params) => {
    expect(() => resolveReportRange(params, TZ, NOW)).toThrow(InvalidReportRangeError)
  })
})

describe('resolveReportRange — custom range', () => {
  it('interprets from/to in the user timezone with an inclusive user-facing end date', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TZ,
      NOW,
    )
    expect(r.kind).toBe('custom')
    // 1 Mar 00:00 +07:00
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    // exclusive bound = 1 Apr 00:00 +07:00, so 31 Mar 23:59:59 local is included
    expect(r.endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it('is timezone-aware across DST (America/New_York, single-day range in July)', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-07-01', to: '2026-07-01' },
      NY,
      NOW,
    )
    expect(r.startUtc.toISOString()).toBe('2026-07-01T04:00:00.000Z') // EDT, UTC-4
    expect(r.endUtc.toISOString()).toBe('2026-07-02T04:00:00.000Z')
  })

  it('takes the exclusive bound from the day *after* `to`, offset and all, across a DST start', () => {
    // New York moves to EDT at 02:00 on Sunday 8 March 2026. The range's own
    // days are EST (UTC-5); the day after `to` is already EDT (UTC-4), so an
    // implementation that added 24h to `to`'s midnight would land an hour late
    // and sweep in an extra hour of 9 March.
    const r = resolveReportRange(
      { period: 'custom', from: '2026-03-07', to: '2026-03-08' },
      NY,
      NOW,
    )
    expect(r.startUtc.toISOString()).toBe('2026-03-07T05:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('rolls the exclusive bound over a month and a year boundary', () => {
    const endOfYear = resolveReportRange(
      { period: 'custom', from: '2026-12-01', to: '2026-12-31' },
      'UTC',
      NOW,
    )
    expect(endOfYear.endUtc.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    const endOfFebruary = resolveReportRange(
      { period: 'custom', from: '2024-02-01', to: '2024-02-29' },
      'UTC',
      NOW,
    )
    expect(endOfFebruary.endUtc.toISOString()).toBe('2024-03-01T00:00:00.000Z')
  })

  it('accepts a single day, where from equals to', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-01' },
      TZ,
      NOW,
    )
    expect(r.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('2026-03-01T17:00:00.000Z')
  })

  it('rejects from > to', () => {
    expect(() =>
      resolveReportRange({ period: 'custom', from: '2026-03-31', to: '2026-03-01' }, TZ, NOW),
    ).toThrow(InvalidReportRangeError)
  })

  it.each([
    ['2026-13-01', '2026-13-05'],
    ['2026-02-30', '2026-03-01'],
    ['garbage', '2026-03-01'],
    ['2026-03-01', undefined],
    [undefined, '2026-03-31'],
    [undefined, undefined],
    ['03/01/2026', '03/31/2026'],
    ['2026-3-1', '2026-3-31'],
    ['2026-03-01T00:00', '2026-03-31T00:00'],
  ])('rejects malformed or impossible dates %j..%j', (from, to) => {
    expect(() => resolveReportRange({ period: 'custom', from, to }, TZ, NOW)).toThrow(
      InvalidReportRangeError,
    )
  })

  it('round-trips through the query string so export links carry the exact same range', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TZ,
      NOW,
    )
    const qs = rangeToQueryString(r)
    expect(qs).toBe('period=custom&from=2026-03-01&to=2026-03-31')
    const again = resolveReportRange(Object.fromEntries(new URLSearchParams(qs)), TZ, NOW)
    expect(again.startUtc.getTime()).toBe(r.startUtc.getTime())
    expect(again.endUtc.getTime()).toBe(r.endUtc.getTime())
  })

  it('round-trips a named period too, without inventing from/to', () => {
    const r = resolveReportRange({ period: 'quarter' }, TZ, NOW)
    const qs = rangeToQueryString(r)
    expect(qs).toBe('period=quarter')
    const again = resolveReportRange(Object.fromEntries(new URLSearchParams(qs)), TZ, NOW)
    expect(again.startUtc.getTime()).toBe(r.startUtc.getTime())
    expect(again.endUtc.getTime()).toBe(r.endUtc.getTime())
  })
})

describe('resolveReportRange — supported calendar years', () => {
  /**
   * A date can be real and still be unusable. Two ways, both reachable from a
   * hand-typed URL:
   *
   * - `9999-12-31` is a real day whose *successor* is year 10000, which
   *   `Date#toISOString` writes in expanded form (`+010000-01-01T…`). Sliced to
   *   ten characters that is `+010000-0`, which parses to an Invalid Date and
   *   would reach Prisma as `lt: NaN` — a 500, not the inline message the page
   *   promises.
   * - `0099-01-01` is a real day that `Date.UTC` maps to *1999*, because years
   *   0–99 are two-digit years to that constructor. The range would silently
   *   cover a different two millennia than the one the user typed.
   *
   * Both are excluded by bounding the accepted year, which is tested at each
   * edge below rather than only in the middle.
   */
  it.each([
    ['to is far in the future', '2026-03-01', '9999-12-31'],
    ['from is in year 1', '0001-01-01', '2026-03-01'],
    ['from is a two-digit year Date.UTC would remap', '0099-01-01', '2026-03-01'],
    ['from is just below the lower bound', '1899-12-31', '1900-01-31'],
    ['to is just above the upper bound', '2999-12-31', '3000-01-01'],
  ])('rejects a custom range where %s', (_why, from, to) => {
    expect(() => resolveReportRange({ period: 'custom', from, to }, TZ, NOW)).toThrow(
      InvalidReportRangeError,
    )
  })

  it('accepts the first supported day', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '1900-01-01', to: '1900-01-02' },
      'UTC',
      NOW,
    )
    expect(r.startUtc.toISOString()).toBe('1900-01-01T00:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('1900-01-03T00:00:00.000Z')
  })

  it('accepts the last supported day, rolling its exclusive bound into the next millennium', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2999-12-01', to: '2999-12-31' },
      'UTC',
      NOW,
    )
    expect(r.startUtc.toISOString()).toBe('2999-12-01T00:00:00.000Z')
    expect(r.endUtc.toISOString()).toBe('3000-01-01T00:00:00.000Z')
  })

  it('never returns a bound a database query could not use', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2999-12-31', to: '2999-12-31' },
      TZ,
      NOW,
    )
    expect(Number.isNaN(r.startUtc.getTime())).toBe(false)
    expect(Number.isNaN(r.endUtc.getTime())).toBe(false)
  })
})

describe('describeRange', () => {
  it('labels a custom range with the dates the user typed, end inclusive', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TZ,
      NOW,
    )
    expect(describeRange(r, TZ)).toEqual({
      fromLabel: '2026-03-01',
      toLabelInclusive: '2026-03-31',
    })
  })

  it('labels a named period by its local calendar days, never the exclusive bound', () => {
    const r = resolveReportRange({ period: 'month' }, TZ, NOW)
    // `endUtc` is 1 April 00:00 local; the last *included* day is 31 March.
    expect(describeRange(r, TZ)).toEqual({
      fromLabel: '2026-03-01',
      toLabelInclusive: '2026-03-31',
    })
  })

  it('labels a single-day range as that one day', () => {
    const r = resolveReportRange({ period: 'day' }, TZ, NOW)
    expect(describeRange(r, TZ)).toEqual({
      fromLabel: '2026-03-15',
      toLabelInclusive: '2026-03-15',
    })
  })

  it('reads the labels in the given timezone, not the server one', () => {
    const r = resolveReportRange(
      { period: 'custom', from: '2026-07-01', to: '2026-07-01' },
      NY,
      NOW,
    )
    expect(describeRange(r, NY)).toEqual({
      fromLabel: '2026-07-01',
      toLabelInclusive: '2026-07-01',
    })
  })
})

describe('InvalidReportRangeError', () => {
  it('is a named Error so a page can catch exactly it', () => {
    const error = new InvalidReportRangeError('nope')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('InvalidReportRangeError')
    expect(error.message).toBe('nope')
  })
})

describe('offendingReportRangeParam', () => {
  // The whole point: the field name is safe to log, the rest of the message
  // (a hand-typed date, a bogus period string) is not. These pin that only the
  // field name ever comes back, never the raw value sitting next to it.
  it.each([
    ['The period parameter was given more than once', 'period'],
    ['The from parameter was given more than once', 'from'],
    ['The to parameter was given more than once', 'to'],
    ['from must be a real calendar date in YYYY-MM-DD format (got "2026-13-40")', 'from'],
    ['to must fall between 1900-01-01 and 2999-12-31 (got 3000-01-01)', 'to'],
    ['from (2026-04-01) must be on or before to (2026-03-01)', 'from'],
    [
      'Unknown period "weekly" — expected one of day, week, month, quarter, year or custom',
      'period',
    ],
  ])('returns only the field name for %j', (message, field) => {
    expect(offendingReportRangeParam(message)).toBe(field)
  })

  it('returns undefined for a message naming none of the three fields', () => {
    expect(offendingReportRangeParam('No usable day follows 9999-12-31')).toBeUndefined()
  })
})
