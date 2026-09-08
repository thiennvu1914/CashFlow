import { describe, expect, it } from 'vitest'
import {
  CALENDAR_DATE_RE,
  calendarDateToUtcCarrier,
  calendarDaysBetween,
  compareCalendarDates,
  formatCalendarDate,
  isRealCalendarDate,
  todayCalendarDateInZone,
} from './calendar-date'

describe('isRealCalendarDate', () => {
  it.each(['2026-03-01', '2026-02-28', '2024-02-29', '1999-12-31', '2026-01-01'])(
    'accepts the real calendar date %j',
    (value) => {
      expect(isRealCalendarDate(value)).toBe(true)
    },
  )

  it.each([
    // Right shape, no such day — the case a `new Date(...)` parse would roll
    // over into the following month instead of rejecting.
    '2026-02-30',
    '2026-02-31',
    '2025-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
  ])('rejects the impossible date %j', (value) => {
    expect(isRealCalendarDate(value)).toBe(false)
  })

  it.each([
    '',
    '2026-3-01',
    '26-03-01',
    '2026-03-1',
    '03/01/2026',
    'garbage',
    '2026-03-01T00:00',
    '2026-03-01 ',
    ' 2026-03-01',
    '+2026-03-01',
  ])('rejects the malformed value %j', (value) => {
    expect(isRealCalendarDate(value)).toBe(false)
  })

  it('exposes the shape it accepts, anchored at both ends', () => {
    expect(CALENDAR_DATE_RE.test('2026-03-01')).toBe(true)
    expect(CALENDAR_DATE_RE.test('x2026-03-01x')).toBe(false)
  })
})

describe('the UTC-midnight carrier (ruling R6-7)', () => {
  it.each(['2026-03-31', '2026-01-01', '2024-02-29', '2026-12-31'])(
    'round-trips %j through the carrier unchanged',
    (value) => {
      expect(formatCalendarDate(calendarDateToUtcCarrier(value))).toBe(value)
    },
  )

  it('builds midnight UTC, not midnight in whatever zone the process runs in', () => {
    // The whole point of the carrier: the instant's UTC components ARE the
    // calendar date, so `TZ=Asia/Ho_Chi_Minh` and `TZ=UTC` store the same row.
    expect(calendarDateToUtcCarrier('2026-03-31').toISOString()).toBe('2026-03-31T00:00:00.000Z')
    expect(calendarDateToUtcCarrier('2026-03-31').getUTCHours()).toBe(0)
  })

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-3-1', '', 'garbage'])(
    'refuses to carry %j rather than rolling it over',
    (value) => {
      // `new Date('2026-02-30T00:00:00Z')` is Invalid Date, but
      // `new Date(2026, 1, 30)` silently becomes 2 March — a deadline the user
      // never picked. Either way this throws instead of storing something.
      expect(() => calendarDateToUtcCarrier(value)).toThrow(RangeError)
    },
  )

  it('reads a carrier back in UTC even for a zone-shifted instant', () => {
    // Not a carrier at all — a real instant. `formatCalendarDate` still answers
    // its UTC day, which is what makes it the exact inverse of the builder
    // rather than something that depends on the reader's zone.
    expect(formatCalendarDate(new Date('2026-03-31T23:59:59.999Z'))).toBe('2026-03-31')
    expect(formatCalendarDate(new Date('2026-04-01T00:00:00.000Z'))).toBe('2026-04-01')
  })
})

describe('todayCalendarDateInZone', () => {
  /** 2026-04-01 00:30 in `Asia/Ho_Chi_Minh` (+07); still 31 March in UTC. */
  const INSTANT = new Date('2026-03-31T17:30:00.000Z')

  it('answers the local day east of UTC, where the date has already turned', () => {
    expect(todayCalendarDateInZone('Asia/Ho_Chi_Minh', INSTANT)).toBe('2026-04-01')
  })

  it('answers the local day west of UTC, where it has not', () => {
    expect(todayCalendarDateInZone('America/Los_Angeles', INSTANT)).toBe('2026-03-31')
  })

  it('is not the UTC day — the two zones straddle it', () => {
    // The same instant reads as three different days, so a page that used
    // `toISOString()` here would be wrong for one user or the other.
    expect(todayCalendarDateInZone('UTC', INSTANT)).toBe('2026-03-31')
    expect(todayCalendarDateInZone('Pacific/Kiritimati', INSTANT)).toBe('2026-04-01')
  })
})

describe('compareCalendarDates', () => {
  it.each([
    ['2026-03-01', '2026-03-02', -1],
    ['2026-03-02', '2026-03-01', 1],
    ['2026-03-01', '2026-03-01', 0],
    // Across a month and a year boundary, where a naive numeric parse of the
    // parts would need three comparisons and a lexicographic one needs none.
    ['2026-02-28', '2026-03-01', -1],
    ['2025-12-31', '2026-01-01', -1],
    // Zero padding is what makes the string order chronological: '2026-09-01'
    // must sort before '2026-10-01', not after it the way '9' > '1' would.
    ['2026-09-01', '2026-10-01', -1],
  ] as const)('compares %j to %j as %i', (a, b, expected) => {
    expect(compareCalendarDates(a, b)).toBe(expected)
  })

  it('rejects a value whose width would make the comparison silently wrong', () => {
    // '2026-3-1' > '2026-12-01' lexicographically, i.e. March would sort after
    // December. Refusing the shape is the only safe answer.
    expect(() => compareCalendarDates('2026-3-1', '2026-12-01')).toThrow(RangeError)
    expect(() => compareCalendarDates('2026-12-01', '')).toThrow(RangeError)
  })

  it('does not require either day to exist — ordering is not a reality check', () => {
    expect(compareCalendarDates('2026-02-30', '2026-03-01')).toBe(-1)
  })
})

describe('calendarDaysBetween', () => {
  it('counts forward', () => {
    expect(calendarDaysBetween('2026-09-08', '2026-09-11')).toBe(3)
  })

  it('counts backward as negative', () => {
    expect(calendarDaysBetween('2026-09-11', '2026-09-08')).toBe(-3)
  })

  it('is exact across a DST boundary — carrier arithmetic, never instant arithmetic', () => {
    // 2026-03-28 to 2026-03-30 spans the (northern-hemisphere) spring-forward
    // transition in most zones that observe DST; the whole point of computing
    // this on UTC-midnight carriers rather than on the instants the dates came
    // from is that a real two-day gap can never measure anything else, even in
    // a zone where the clock itself skipped an hour that week.
    expect(calendarDaysBetween('2026-03-28', '2026-03-30')).toBe(2)
  })
})
