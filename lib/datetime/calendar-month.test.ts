import { describe, expect, it } from 'vitest'
import {
  MAX_BUDGET_YEAR,
  MIN_BUDGET_YEAR,
  addCalendarMonths,
  formatCalendarMonth,
  getCalendarMonth,
  getCalendarMonthBounds,
  isBudgetableMonth,
  parseCalendarMonth,
} from './calendar-month'

/**
 * Pure date arithmetic — no database, no clock, no ambient timezone: every case
 * names the zone it is asking about, so the suite answers the same on a UTC CI
 * box and on a developer's machine in `Asia/Ho_Chi_Minh`.
 *
 * The property under test throughout is that a named month ("March 2026") is a
 * *local* window: the same pair of integers maps to different UTC instants for a
 * user ahead of UTC and one behind it, and the boundaries follow the local
 * calendar rather than midnight UTC.
 */

const HCMC = 'Asia/Ho_Chi_Minh'
const LOS_ANGELES = 'America/Los_Angeles'

describe('getCalendarMonthBounds', () => {
  it('returns the local month window for a zone ahead of UTC', () => {
    const { startUtc, endUtc } = getCalendarMonthBounds(HCMC, 2026, 3)

    // +07 with no DST: local midnight is 17:00Z on the preceding UTC day.
    expect(startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it('returns the local month window for a zone behind UTC, spanning a DST change', () => {
    const { startUtc, endUtc } = getCalendarMonthBounds(LOS_ANGELES, 2026, 3)

    // March starts in PST (UTC−8) and ends in PDT (UTC−7): the window is one
    // hour short of a naive fixed-offset month, which is exactly the seam a
    // fixed-offset calculation would get wrong.
    expect(startUtc.toISOString()).toBe('2026-03-01T08:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-04-01T07:00:00.000Z')
  })

  it('gets January and December right, where a mid-month reference could not slip a year', () => {
    expect(getCalendarMonthBounds(HCMC, 2026, 1).startUtc.toISOString()).toBe(
      '2025-12-31T17:00:00.000Z',
    )
    expect(getCalendarMonthBounds(HCMC, 2026, 12).endUtc.toISOString()).toBe(
      '2026-12-31T17:00:00.000Z',
    )
  })

  it('produces contiguous, non-overlapping windows across a whole year', () => {
    for (let month = 1; month < 12; month++) {
      const current = getCalendarMonthBounds(LOS_ANGELES, 2026, month)
      const next = getCalendarMonthBounds(LOS_ANGELES, 2026, month + 1)
      // `endUtc` is exclusive, so it is exactly where the next month begins.
      expect(current.endUtc.getTime()).toBe(next.startUtc.getTime())
      expect(current.startUtc.getTime()).toBeLessThan(current.endUtc.getTime())
    }
  })

  it('rejects a month outside 1–12', () => {
    expect(() => getCalendarMonthBounds(HCMC, 2026, 13)).toThrow(RangeError)
    expect(() => getCalendarMonthBounds(HCMC, 2026, 0)).toThrow(RangeError)
    expect(() => getCalendarMonthBounds(HCMC, 2026, 3.5)).toThrow(RangeError)
  })
})

describe('getCalendarMonth', () => {
  it('reads an instant as the local month, not the UTC one', () => {
    // 00:30 on 1 April in Ho Chi Minh City, still 31 March in UTC.
    const instant = new Date('2026-03-31T17:30:00.000Z')

    expect(getCalendarMonth(HCMC, instant)).toEqual({ year: 2026, month: 4 })
    expect(getCalendarMonth('UTC', instant)).toEqual({ year: 2026, month: 3 })
  })

  it('agrees with getCalendarMonthBounds on the first instant of a month', () => {
    const { startUtc } = getCalendarMonthBounds(HCMC, 2026, 3)

    expect(getCalendarMonth(HCMC, startUtc)).toEqual({ year: 2026, month: 3 })
    // One millisecond earlier is still February locally.
    expect(getCalendarMonth(HCMC, new Date(startUtc.getTime() - 1))).toEqual({
      year: 2026,
      month: 2,
    })
  })
})

describe('formatCalendarMonth / parseCalendarMonth', () => {
  it('round trips yyyy-MM', () => {
    expect(formatCalendarMonth({ year: 2026, month: 3 })).toBe('2026-03')
    expect(formatCalendarMonth({ year: 2026, month: 12 })).toBe('2026-12')
    expect(parseCalendarMonth('2026-03')).toEqual({ year: 2026, month: 3 })
    expect(parseCalendarMonth(formatCalendarMonth({ year: 2025, month: 9 }))).toEqual({
      year: 2025,
      month: 9,
    })
  })

  it('returns null for anything not matching yyyy-MM with a real month', () => {
    for (const value of ['', '2026', '2026-3', '2026-00', '2026-13', '26-03', '2026-03-01', 'x']) {
      expect(parseCalendarMonth(value)).toBeNull()
    }
  })
})

describe('isBudgetableMonth', () => {
  it('accepts the two boundary years', () => {
    expect(isBudgetableMonth({ year: MIN_BUDGET_YEAR, month: 1 })).toBe(true)
    expect(isBudgetableMonth({ year: MIN_BUDGET_YEAR, month: 12 })).toBe(true)
    expect(isBudgetableMonth({ year: MAX_BUDGET_YEAR, month: 1 })).toBe(true)
    expect(isBudgetableMonth({ year: MAX_BUDGET_YEAR, month: 12 })).toBe(true)
  })

  it('rejects a year one step outside either boundary', () => {
    expect(isBudgetableMonth({ year: MIN_BUDGET_YEAR - 1, month: 12 })).toBe(false)
    expect(isBudgetableMonth({ year: MAX_BUDGET_YEAR + 1, month: 1 })).toBe(false)
  })
})

describe('addCalendarMonths', () => {
  it('steps back across a year boundary', () => {
    expect(addCalendarMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(addCalendarMonths({ year: 2026, month: 1 }, -13)).toEqual({ year: 2024, month: 12 })
  })

  it('steps forward across a year boundary', () => {
    expect(addCalendarMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(addCalendarMonths({ year: 2026, month: 3 }, 24)).toEqual({ year: 2028, month: 3 })
  })

  it('is the identity for a zero delta', () => {
    expect(addCalendarMonths({ year: 2026, month: 7 }, 0)).toEqual({ year: 2026, month: 7 })
  })

  it('rejects an invalid month or a fractional delta', () => {
    expect(() => addCalendarMonths({ year: 2026, month: 13 }, 1)).toThrow(RangeError)
    expect(() => addCalendarMonths({ year: 2026, month: 1 }, 1.5)).toThrow(RangeError)
  })
})
