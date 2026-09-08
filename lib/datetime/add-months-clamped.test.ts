import { describe, expect, it } from 'vitest'
import { addMonthsUtcClamped, advanceByFrequency, daysInUtcMonth } from './add-months-clamped'

/**
 * What this suite exists to pin down is the *anchor*, not just the clamping.
 *
 * A loan due on the 31st is the case every naive implementation gets wrong, and
 * it gets it wrong twice over:
 *
 * - `setUTCMonth(+1)` on 31 January overflows into "31 February" and silently
 *   lands on 3 March — a due date the user never agreed to;
 * - clamping alone fixes that once and then loses the schedule forever: Jan 31
 *   → Feb 28 → **Mar 28**, so a payment date drifts three days earlier for the
 *   rest of the loan.
 *
 * Only carrying the *agreed* day of the month separately (`anchorDay`) gives the
 * schedule a real calendar reads: Jan 31 → Feb 28 → Mar 31. Every assertion
 * below is on UTC-midnight calendar-date carriers (ruling R6-7), so nothing here
 * depends on the machine's timezone.
 */

/** The UTC-midnight carrier for a `yyyy-MM-dd` calendar date. */
const carrier = (value: string) => new Date(`${value}T00:00:00.000Z`)

/** A result's calendar date, read in UTC — a carrier has no other zone. */
const day = (date: Date) => date.toISOString().slice(0, 10)

describe('daysInUtcMonth', () => {
  it('answers the real length of each month of a common year', () => {
    const lengths = Array.from({ length: 12 }, (_, monthIndex) => daysInUtcMonth(2026, monthIndex))

    expect(lengths).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
  })

  it('answers 29 for February of a leap year, century rule included', () => {
    expect(daysInUtcMonth(2024, 1)).toBe(29)
    expect(daysInUtcMonth(2028, 1)).toBe(29)
    // 2000 is a leap year and 1900 is not — the /100 and /400 rules, which a
    // hand-rolled `year % 4 === 0` would get wrong for one of them.
    expect(daysInUtcMonth(2000, 1)).toBe(29)
    expect(daysInUtcMonth(1900, 1)).toBe(28)
  })

  it('rejects a month index outside 0–11 rather than rolling into another year', () => {
    expect(() => daysInUtcMonth(2026, 12)).toThrow(RangeError)
    expect(() => daysInUtcMonth(2026, -1)).toThrow(RangeError)
  })
})

describe('addMonthsUtcClamped', () => {
  it('clamps 31 January to the last day of February', () => {
    // The case `setUTCMonth` turns into 3 March.
    expect(day(addMonthsUtcClamped(carrier('2026-01-31'), 1))).toBe('2026-02-28')
  })

  it('lands on 29 February in a leap year', () => {
    expect(day(addMonthsUtcClamped(carrier('2028-01-31'), 1))).toBe('2028-02-29')
  })

  it('clamps 29 February to the 28th a year later', () => {
    expect(day(addMonthsUtcClamped(carrier('2028-02-29'), 12))).toBe('2029-02-28')
  })

  it('keeps a month-end schedule on the 31st instead of drifting to the 28th', () => {
    const february = addMonthsUtcClamped(carrier('2026-01-31'), 1, 31)
    expect(day(february)).toBe('2026-02-28')

    // The whole point of the anchor: the *next* step starts from 28 February
    // but still knows the agreed day is the 31st.
    expect(day(addMonthsUtcClamped(february, 1, 31))).toBe('2026-03-31')
    // Without it, the schedule would be stuck three days early for good.
    expect(day(addMonthsUtcClamped(february, 1))).toBe('2026-03-28')
  })

  it('clamps the anchor day to a 30-day month', () => {
    expect(day(addMonthsUtcClamped(carrier('2026-03-31'), 1, 31))).toBe('2026-04-30')
    expect(day(addMonthsUtcClamped(carrier('2026-04-30'), 1, 31))).toBe('2026-05-31')
  })

  it('restores a 29 February anchor in the next leap year', () => {
    const leapDay = carrier('2024-02-29')

    expect(day(addMonthsUtcClamped(leapDay, 12, 29))).toBe('2025-02-28')
    expect(day(addMonthsUtcClamped(leapDay, 24, 29))).toBe('2026-02-28')
    expect(day(addMonthsUtcClamped(leapDay, 36, 29))).toBe('2027-02-28')
    // Four years on the day exists again, and the anchor brings it back rather
    // than leaving the loan on the 28th for the rest of its term.
    expect(day(addMonthsUtcClamped(leapDay, 48, 29))).toBe('2028-02-29')
  })

  it('preserves the time of day', () => {
    // A calendar-date carrier is always 00:00Z, so this is about the function
    // staying honest for any `Date` a caller hands it — it adds months and
    // nothing else.
    expect(addMonthsUtcClamped(new Date('2026-01-31T09:30:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T09:30:00.000Z',
    )
    expect(addMonthsUtcClamped(new Date('2026-01-31T23:59:59.999Z'), 1).toISOString()).toBe(
      '2026-02-28T23:59:59.999Z',
    )
  })

  it('rolls over the year in December', () => {
    expect(day(addMonthsUtcClamped(carrier('2026-12-15'), 1))).toBe('2027-01-15')
    expect(day(addMonthsUtcClamped(carrier('2026-12-31'), 1, 31))).toBe('2027-01-31')
  })

  it('walks backwards for a negative month count', () => {
    // `Math.floor` rather than a truncating division is what makes the year
    // border work in this direction.
    expect(day(addMonthsUtcClamped(carrier('2026-03-31'), -1, 31))).toBe('2026-02-28')
    expect(day(addMonthsUtcClamped(carrier('2026-01-15'), -1))).toBe('2025-12-15')
    expect(day(addMonthsUtcClamped(carrier('2026-01-31'), -13, 31))).toBe('2024-12-31')
  })

  it('adds nothing for zero months, still returning a distinct Date', () => {
    const start = carrier('2026-01-31')

    const same = addMonthsUtcClamped(start, 0)

    expect(same.toISOString()).toBe(start.toISOString())
    // A fresh object: a caller that mutated the result must not be able to
    // change the loan row's own `nextDueDate` instance.
    expect(same).not.toBe(start)
    expect(day(start)).toBe('2026-01-31')
  })

  it('rejects an invalid date, a fractional month count and an impossible anchor day', () => {
    expect(() => addMonthsUtcClamped(new Date('nonsense'), 1)).toThrow(RangeError)
    expect(() => addMonthsUtcClamped(carrier('2026-01-31'), 1.5)).toThrow(RangeError)
    expect(() => addMonthsUtcClamped(carrier('2026-01-31'), 1, 0)).toThrow(RangeError)
    expect(() => addMonthsUtcClamped(carrier('2026-01-31'), 1, 32)).toThrow(RangeError)
    expect(() => addMonthsUtcClamped(carrier('2026-01-31'), 1, 15.5)).toThrow(RangeError)
  })
})

describe('advanceByFrequency', () => {
  it('adds exactly seven days for WEEKLY and ignores the anchor day', () => {
    expect(day(advanceByFrequency(carrier('2026-01-31'), 'WEEKLY'))).toBe('2026-02-07')
    // A weekly schedule has no day of the month to hold on to — the anchor is
    // meaningless here and must not bend the result.
    expect(day(advanceByFrequency(carrier('2026-01-31'), 'WEEKLY', 31))).toBe('2026-02-07')
    expect(day(advanceByFrequency(carrier('2026-12-28'), 'WEEKLY'))).toBe('2027-01-04')
    // Across 29 February, which a "+1 month then subtract" scheme would miss.
    expect(day(advanceByFrequency(carrier('2028-02-25'), 'WEEKLY'))).toBe('2028-03-03')
  })

  it('advances one month for MONTHLY, honouring the anchor day', () => {
    expect(day(advanceByFrequency(carrier('2026-02-28'), 'MONTHLY', 31))).toBe('2026-03-31')
    expect(day(advanceByFrequency(carrier('2026-01-31'), 'MONTHLY', 31))).toBe('2026-02-28')
    expect(day(advanceByFrequency(carrier('2026-02-01'), 'MONTHLY', 1))).toBe('2026-03-01')
    // No anchor: the carrier's own day, exactly as `addMonthsUtcClamped` does.
    expect(day(advanceByFrequency(carrier('2026-02-28'), 'MONTHLY'))).toBe('2026-03-28')
  })

  it('advances twelve months for YEARLY, honouring the anchor day', () => {
    expect(day(advanceByFrequency(carrier('2028-02-29'), 'YEARLY', 29))).toBe('2029-02-28')
    expect(day(advanceByFrequency(carrier('2029-02-28'), 'YEARLY', 29))).toBe('2030-02-28')
    expect(day(advanceByFrequency(carrier('2026-01-31'), 'YEARLY', 31))).toBe('2027-01-31')
  })

  it('preserves the time of day for every frequency', () => {
    const instant = new Date('2026-01-31T09:30:00.000Z')

    expect(advanceByFrequency(instant, 'WEEKLY').toISOString()).toBe('2026-02-07T09:30:00.000Z')
    expect(advanceByFrequency(instant, 'MONTHLY', 31).toISOString()).toBe(
      '2026-02-28T09:30:00.000Z',
    )
    expect(advanceByFrequency(instant, 'YEARLY', 31).toISOString()).toBe('2027-01-31T09:30:00.000Z')
  })
})
