import { describe, expect, it } from 'vitest'
import { calendarDateToUtcCarrier, formatCalendarDate } from '@/lib/datetime/calendar-date'
import { computeDueDates, oneIntervalBefore, type RecurrenceRule } from './recurrence'

/**
 * Group 6's recurrence acceptance check (spec §4.7) — pure, no database, no
 * timezone.
 *
 * Every `Date` here is a **local calendar date carrier**: a UTC-midnight `Date`
 * whose UTC year/month/day *are* the user's local day
 * (`lib/datetime/calendar-date.ts`). The module under test does calendar
 * arithmetic on those three components and nothing else, so the assertions below
 * are deterministic whatever `TZ` the host is set to — and they are written as
 * `yyyy-MM-dd` strings rather than instants precisely so a reviewer can read the
 * calendar the user would see.
 *
 * Four properties are what this suite exists to hold:
 *
 * 1. **Month lengths are respected, and the anchor never decays.** A reminder on
 *    the 31st reads Jan 31 → Feb 28 → Mar 31 → Apr 30, not Jan 31 → Feb 28 →
 *    Mar 28 (a schedule that clamps and then steps from the clamped result) and
 *    not Jan 31 → Mar 3 (a `setUTCMonth` rollover). February 29 exists in 2028
 *    and does not in 2029.
 * 2. **Nothing before `startDate`, ever.** A rule's anchor day or anchor month
 *    can place its first candidate before the day the user picked; that
 *    candidate is dropped rather than surfaced as an occurrence that predates
 *    the reminder.
 * 3. **ONE_TIME is one date or none.** It is never stepped and never clamped —
 *    the overdue one-time reminder the service must still surface (directive O)
 *    depends on this.
 * 4. **No unbounded work.** `interval < 1` is refused rather than looped on
 *    forever, `to < from` is empty, and a pathological range is refused with a
 *    thrown error instead of building a million dates.
 */

/** A local calendar date carrier from the `yyyy-MM-dd` a user would type. */
const c = calendarDateToUtcCarrier

/** The calendar days a run produced, in the form the user reads them. */
const days = (dates: Date[]) => dates.map(formatCalendarDate)

describe('computeDueDates', () => {
  describe('ONE_TIME', () => {
    it('returns a single date for ONE_TIME within range, none outside it', () => {
      const rule: RecurrenceRule = {
        frequency: 'ONE_TIME',
        interval: 1,
        startDate: c('2026-03-15'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-12-31')))).toEqual(['2026-03-15'])
      expect(computeDueDates(rule, c('2026-04-01'), c('2026-12-31'))).toEqual([])
      // Before the window as well as after it: a one-time date the range has not
      // reached yet is not due.
      expect(computeDueDates(rule, c('2026-01-01'), c('2026-03-14'))).toEqual([])
    })

    it('includes a ONE_TIME date that sits exactly on either boundary', () => {
      const rule: RecurrenceRule = {
        frequency: 'ONE_TIME',
        interval: 1,
        startDate: c('2026-03-15'),
      }

      expect(days(computeDueDates(rule, c('2026-03-15'), c('2026-03-15')))).toEqual(['2026-03-15'])
    })

    it('returns exactly one date for a long-past ONE_TIME started at `from`', () => {
      // The shape the service materializes an overdue one-time reminder with
      // (directive O): `from` is the reminder's own `startDate`, never clamped
      // to one interval back, and six years of being overdue must still produce
      // one occurrence rather than none or many.
      const rule: RecurrenceRule = {
        frequency: 'ONE_TIME',
        interval: 1,
        startDate: c('2020-01-01'),
      }

      expect(days(computeDueDates(rule, c('2020-01-01'), c('2026-04-14')))).toEqual(['2020-01-01'])
    })

    it('ignores dayOfMonth and month on a ONE_TIME rule rather than clamping it', () => {
      // A one-time reminder has no anchor to hold on to, so a stray anchor from
      // an earlier edit must not move the date the user picked.
      const rule: RecurrenceRule = {
        frequency: 'ONE_TIME',
        interval: 1,
        dayOfMonth: 1,
        month: 12,
        startDate: c('2026-03-31'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-12-31')))).toEqual(['2026-03-31'])
    })
  })

  describe('WEEKLY', () => {
    it('generates weekly occurrences on the correct interval', () => {
      const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 2, startDate: c('2026-01-05') }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-02-01')))).toEqual([
        '2026-01-05',
        '2026-01-19',
      ])
    })

    it('steps a fortnightly rule straight across a month boundary', () => {
      // 5 January is a Monday; every date below must be one too, which is what a
      // 7-day step on a UTC carrier guarantees (no DST exists in UTC, so the
      // arithmetic cannot land 23 or 25 hours out).
      const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 2, startDate: c('2026-01-05') }

      const dates = computeDueDates(rule, c('2026-01-05'), c('2026-03-31'))

      expect(days(dates)).toEqual([
        '2026-01-05',
        '2026-01-19',
        '2026-02-02',
        '2026-02-16',
        '2026-03-02',
        '2026-03-16',
        '2026-03-30',
      ])
      expect(dates.every((date) => date.getUTCDay() === 1)).toBe(true)
    })

    it('generates every week for interval 1, including across a leap day', () => {
      const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, startDate: c('2028-02-21') }

      expect(days(computeDueDates(rule, c('2028-02-21'), c('2028-03-14')))).toEqual([
        '2028-02-21',
        '2028-02-28',
        '2028-03-06',
        '2028-03-13',
      ])
    })

    it('starts a weekly rule at the first occurrence at or after `from`', () => {
      const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, startDate: c('2026-01-05') }

      expect(days(computeDueDates(rule, c('2026-01-20'), c('2026-02-10')))).toEqual([
        '2026-01-26',
        '2026-02-02',
        '2026-02-09',
      ])
    })
  })

  describe('MONTHLY', () => {
    it('clamps dayOfMonth to the last valid day for shorter months', () => {
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 1,
        dayOfMonth: 31,
        startDate: c('2026-01-31'),
      }

      const dates = computeDueDates(rule, c('2026-01-01'), c('2026-04-01'))

      // Jan 31, Feb 28 (2026 is not a leap year), Mar 31.
      expect(dates.map((date) => date.getUTCDate())).toEqual([31, 28, 31])
    })

    it('holds the 31st as its anchor across Jan → Feb → Mar → Apr rather than decaying', () => {
      // The whole point of anchoring: a schedule that clamped to Feb 28 and then
      // stepped from *that* would read 31, 28, 28, 28 and be three days early
      // for good.
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 1,
        dayOfMonth: 31,
        startDate: c('2026-01-31'),
      }

      const dates = computeDueDates(rule, c('2026-01-01'), c('2026-04-30'))

      expect(days(dates)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
      expect(dates.map((date) => date.getUTCDate())).toEqual([31, 28, 31, 30])
    })

    it('clamps the 31st to 29 February in a leap year', () => {
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 1,
        dayOfMonth: 31,
        startDate: c('2028-01-31'),
      }

      expect(days(computeDueDates(rule, c('2028-01-01'), c('2028-03-31')))).toEqual([
        '2028-01-31',
        '2028-02-29',
        '2028-03-31',
      ])
    })

    it('steps a quarterly rule by three months', () => {
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 3,
        dayOfMonth: 15,
        startDate: c('2026-01-15'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2027-02-01')))).toEqual([
        '2026-01-15',
        '2026-04-15',
        '2026-07-15',
        '2026-10-15',
        '2027-01-15',
      ])
    })

    it('takes the anchor day from startDate when dayOfMonth is absent', () => {
      const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, startDate: c('2026-01-30') }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-04-30')))).toEqual([
        '2026-01-30',
        '2026-02-28',
        '2026-03-30',
        '2026-04-30',
      ])
    })

    it('never returns a date before startDate', () => {
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 1,
        dayOfMonth: 1,
        startDate: c('2026-06-01'),
      }

      const dates = computeDueDates(rule, c('2026-01-01'), c('2026-12-31'))

      expect(dates.every((date) => date >= rule.startDate)).toBe(true)
      expect(days(dates)[0]).toBe('2026-06-01')
    })

    it('drops the first candidate when the anchor day falls before startDate', () => {
      // Started on the 20th but anchored on the 1st: the 1st of the *start*
      // month is before the reminder existed, so the first occurrence is the
      // following month's.
      const rule: RecurrenceRule = {
        frequency: 'MONTHLY',
        interval: 1,
        dayOfMonth: 1,
        startDate: c('2026-01-20'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-03-31')))).toEqual([
        '2026-02-01',
        '2026-03-01',
      ])
    })
  })

  describe('YEARLY', () => {
    it('generates yearly occurrences on the specified month and day', () => {
      const rule: RecurrenceRule = {
        frequency: 'YEARLY',
        interval: 1,
        month: 12,
        dayOfMonth: 25,
        startDate: c('2025-12-25'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2027-06-01')))).toEqual(['2026-12-25'])
    })

    it('clamps a 29 February anchor to 28 February in non-leap years', () => {
      const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, startDate: c('2028-02-29') }

      expect(days(computeDueDates(rule, c('2028-01-01'), c('2032-12-31')))).toEqual([
        '2028-02-29',
        '2029-02-28',
        '2030-02-28',
        '2031-02-28',
        '2032-02-29',
      ])
    })

    it('uses `month` when it differs from startDate’s own month', () => {
      // Started in June, anchored on 10 March: the March before the start is
      // dropped, so the first occurrence is March of the following year.
      const rule: RecurrenceRule = {
        frequency: 'YEARLY',
        interval: 1,
        month: 3,
        dayOfMonth: 10,
        startDate: c('2026-06-15'),
      }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2029-01-01')))).toEqual([
        '2027-03-10',
        '2028-03-10',
      ])
    })

    it('takes both anchors from startDate when neither is supplied', () => {
      const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, startDate: c('2026-07-04') }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2028-12-31')))).toEqual([
        '2026-07-04',
        '2027-07-04',
        '2028-07-04',
      ])
    })

    it('steps a biennial rule by two years', () => {
      const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 2, startDate: c('2026-07-04') }

      expect(days(computeDueDates(rule, c('2026-01-01'), c('2031-12-31')))).toEqual([
        '2026-07-04',
        '2028-07-04',
        '2030-07-04',
      ])
    })
  })

  describe('guards', () => {
    it.each(['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const)(
      'refuses an interval below 1 for %s rather than looping forever',
      (frequency) => {
        for (const interval of [0, -1]) {
          expect(() =>
            computeDueDates(
              { frequency, interval, startDate: c('2026-01-01') },
              c('2026-01-01'),
              c('2026-12-31'),
            ),
          ).toThrow(RangeError)
        }
      },
    )

    it('refuses a non-integer interval', () => {
      expect(() =>
        computeDueDates(
          { frequency: 'MONTHLY', interval: 1.5, startDate: c('2026-01-01') },
          c('2026-01-01'),
          c('2026-12-31'),
        ),
      ).toThrow(RangeError)
    })

    it.each(['ONE_TIME', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const)(
      'returns nothing for an inverted range on %s',
      (frequency) => {
        const rule: RecurrenceRule = { frequency, interval: 1, startDate: c('2026-01-01') }

        expect(computeDueDates(rule, c('2026-06-01'), c('2026-05-31'))).toEqual([])
      },
    )

    it('refuses a dayOfMonth outside 1–31 and a month outside 1–12', () => {
      const base = { frequency: 'MONTHLY', interval: 1, startDate: c('2026-01-01') } as const

      expect(() =>
        computeDueDates({ ...base, dayOfMonth: 0 }, c('2026-01-01'), c('2026-12-31')),
      ).toThrow(RangeError)
      expect(() =>
        computeDueDates({ ...base, dayOfMonth: 32 }, c('2026-01-01'), c('2026-12-31')),
      ).toThrow(RangeError)
      expect(() =>
        computeDueDates(
          { ...base, frequency: 'YEARLY', month: 0 },
          c('2026-01-01'),
          c('2026-12-31'),
        ),
      ).toThrow(RangeError)
      expect(() =>
        computeDueDates(
          { ...base, frequency: 'YEARLY', month: 13 },
          c('2026-01-01'),
          c('2026-12-31'),
        ),
      ).toThrow(RangeError)
    })

    it('refuses a pathological range instead of building an unbounded array', () => {
      // ~17,000 weeks. The cap is what makes "the loop cannot run away" a
      // property of the code rather than a hope about its inputs — a corrupt
      // `startDate` must fail loudly, not fill a request's memory.
      const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, startDate: c('1700-01-01') }

      expect(() => computeDueDates(rule, c('1700-01-01'), c('2026-12-31'))).toThrow(/10000|10,000/)
    })

    it('does not mutate the rule’s startDate, and returns fresh Date instances', () => {
      const startDate = c('2026-01-31')
      const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, startDate }

      const dates = computeDueDates(rule, c('2026-01-01'), c('2026-03-31'))

      expect(formatCalendarDate(startDate)).toBe('2026-01-31')
      expect(dates[0]).not.toBe(startDate)
      dates[0].setUTCFullYear(1999)
      expect(formatCalendarDate(startDate)).toBe('2026-01-31')
    })
  })
})

describe('oneIntervalBefore', () => {
  it('returns `from` unchanged for ONE_TIME', () => {
    // The service must not clamp a one-time reminder at all (directive O); this
    // is the identity that makes an accidental clamp harmless rather than the
    // reason an overdue one-time reminder disappears.
    const from = c('2026-03-15')

    const result = oneIntervalBefore({ frequency: 'ONE_TIME', interval: 1 }, from)

    expect(formatCalendarDate(result)).toBe('2026-03-15')
    expect(result).not.toBe(from)
  })

  it('goes back 7 days per interval for WEEKLY', () => {
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'WEEKLY', interval: 1 }, c('2026-03-15'))),
    ).toBe('2026-03-08')
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'WEEKLY', interval: 2 }, c('2026-03-15'))),
    ).toBe('2026-03-01')
    // Across a month boundary, and across a leap day.
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'WEEKLY', interval: 1 }, c('2028-03-01'))),
    ).toBe('2028-02-23')
  })

  it('goes back whole months for MONTHLY, clamped to the target month’s length', () => {
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'MONTHLY', interval: 1 }, c('2026-03-31'))),
    ).toBe('2026-02-28')
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'MONTHLY', interval: 1 }, c('2028-03-31'))),
    ).toBe('2028-02-29')
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'MONTHLY', interval: 3 }, c('2026-03-15'))),
    ).toBe('2025-12-15')
  })

  it('goes back whole years for YEARLY, clamped over a leap day', () => {
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'YEARLY', interval: 1 }, c('2026-03-15'))),
    ).toBe('2025-03-15')
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'YEARLY', interval: 1 }, c('2028-02-29'))),
    ).toBe('2027-02-28')
    expect(
      formatCalendarDate(oneIntervalBefore({ frequency: 'YEARLY', interval: 2 }, c('2026-03-15'))),
    ).toBe('2024-03-15')
  })

  it('refuses an interval below 1', () => {
    for (const interval of [0, -1]) {
      expect(() => oneIntervalBefore({ frequency: 'MONTHLY', interval }, c('2026-03-15'))).toThrow(
        RangeError,
      )
    }
  })

  it('does not mutate `from`', () => {
    const from = c('2026-03-31')

    oneIntervalBefore({ frequency: 'MONTHLY', interval: 1 }, from)

    expect(formatCalendarDate(from)).toBe('2026-03-31')
  })
})
