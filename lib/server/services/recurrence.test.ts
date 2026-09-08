import { describe, expect, it } from 'vitest'
import { daysInUtcMonth } from '@/lib/datetime/add-months-clamped'
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

/**
 * A deliberately naive, independent reading of what a rule means, used to prove
 * the arithmetic seek in `computeDueDates` neither skips an occurrence nor
 * emits one twice.
 *
 * It walks the window one day at a time and asks of each day "is this a due
 * date of this rule?", answered from the rule's own definition rather than by
 * stepping a cursor. That makes it structurally independent of the thing under
 * test — the seek's whole risk is landing on the wrong *starting* step, and a
 * scan has no starting step to get wrong. It is far too slow to ship (a
 * ten-year window is 3,650 iterations for six results), which is exactly why
 * the implementation seeks instead.
 */
function bruteForceDueDates(rule: RecurrenceRule, from: Date, to: Date): string[] {
  const out: string[] = []
  for (let ms = from.getTime(); ms <= to.getTime(); ms += 24 * 60 * 60 * 1000) {
    const day = new Date(ms)
    if (ms < rule.startDate.getTime()) continue

    const anchorDay = rule.dayOfMonth ?? rule.startDate.getUTCDate()
    const clampedDay = Math.min(anchorDay, daysInUtcMonth(day.getUTCFullYear(), day.getUTCMonth()))

    switch (rule.frequency) {
      case 'ONE_TIME':
        if (ms === rule.startDate.getTime()) out.push(formatCalendarDate(day))
        break
      case 'WEEKLY': {
        const elapsedDays = (ms - rule.startDate.getTime()) / (24 * 60 * 60 * 1000)
        if (elapsedDays % (7 * rule.interval) === 0) out.push(formatCalendarDate(day))
        break
      }
      case 'MONTHLY': {
        const elapsedMonths =
          (day.getUTCFullYear() - rule.startDate.getUTCFullYear()) * 12 +
          (day.getUTCMonth() - rule.startDate.getUTCMonth())
        if (elapsedMonths % rule.interval === 0 && day.getUTCDate() === clampedDay) {
          out.push(formatCalendarDate(day))
        }
        break
      }
      case 'YEARLY': {
        const anchorMonthIndex = (rule.month ?? rule.startDate.getUTCMonth() + 1) - 1
        const elapsedYears = day.getUTCFullYear() - rule.startDate.getUTCFullYear()
        if (
          day.getUTCMonth() === anchorMonthIndex &&
          elapsedYears % rule.interval === 0 &&
          day.getUTCDate() === clampedDay
        ) {
          out.push(formatCalendarDate(day))
        }
        break
      }
    }
  }
  return out
}

describe('computeDueDates seeks to the window instead of walking from startDate', () => {
  /**
   * The regression this whole seek exists for.
   *
   * Before it, the WEEKLY loop stepped from `startDate`, so a reminder started
   * in 1800 needed 11,806 iterations to reach a 2026 window of six dates — past
   * the 10,000 cap, which threw a `RangeError` out through
   * `materializeDueOccurrences` and `listUpcomingOccurrences` and so broke
   * *every* render of the reminders page and the dashboard widget, permanently,
   * with no way for the user to get back to a working page. Nothing bounds
   * `startDate`: `calendarDateStringSchema` checks shape and reality only, and
   * `<input type="date">` will happily submit `1800-01-05`.
   *
   * The cap itself stays (it is what makes "the loop cannot run away" a
   * property of the code), but it is now only reachable by asking for a
   * genuinely enormous *result* set rather than by an old start date — see the
   * pathological-range case above, which asks for 17,000 dates.
   */
  it('returns a weekly reminder’s 2026 dates for a startDate in 1800, without throwing', () => {
    // 5 January 1800 was a Sunday; 82,607 days — 11,806 weekly steps — before
    // the window below.
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, startDate: c('1800-01-05') }

    const dates = computeDueDates(rule, c('2026-03-08'), c('2026-04-14'))

    expect(days(dates)).toEqual([
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
      '2026-03-29',
      '2026-04-05',
      '2026-04-12',
    ])
    // Still Sundays, 226 years on: the seek moves the cursor, never the phase.
    expect(dates.every((date) => date.getUTCDay() === 0)).toBe(true)
  })

  it('holds a fortnightly phase across 226 years', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 2, startDate: c('1800-01-05') }

    expect(days(computeDueDates(rule, c('2026-03-08'), c('2026-04-14')))).toEqual([
      '2026-03-15',
      '2026-03-29',
      '2026-04-12',
    ])
  })

  it('returns a monthly reminder’s 2026 dates for a startDate in 1000, clamp intact', () => {
    // 12,313 monthly steps away, past the cap's 833-year MONTHLY threshold.
    const rule: RecurrenceRule = {
      frequency: 'MONTHLY',
      interval: 1,
      dayOfMonth: 31,
      startDate: c('1000-01-31'),
    }

    expect(days(computeDueDates(rule, c('2026-02-15'), c('2026-04-14')))).toEqual([
      '2026-02-28',
      '2026-03-31',
    ])
  })

  it('returns a yearly reminder’s 2026 date for a leap-day startDate in 400', () => {
    // 29 February 400 is a real day (400 is divisible by 400), 1,626 yearly
    // steps back, and the anchor still clamps to the 28th in non-leap 2026.
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, startDate: c('0400-02-29') }

    expect(days(computeDueDates(rule, c('2026-02-15'), c('2026-04-14')))).toEqual(['2026-02-28'])
  })

  it('keeps a quarterly phase from 1500 rather than re-phasing on the window', () => {
    // The seek must land on a step that is congruent to the *original* phase:
    // 1500-02 plus a multiple of 3 months is a month with index ≡ 1 (mod 3), so
    // February, May, August and November — and never March.
    const rule: RecurrenceRule = {
      frequency: 'MONTHLY',
      interval: 3,
      dayOfMonth: 10,
      startDate: c('1500-02-10'),
    }

    expect(days(computeDueDates(rule, c('2026-01-01'), c('2026-12-31')))).toEqual([
      '2026-02-10',
      '2026-05-10',
      '2026-08-10',
      '2026-11-10',
    ])
  })

  describe('agrees with a brute-force day-by-day scan', () => {
    const cases: [string, RecurrenceRule, string, string][] = [
      // Recent start dates, where the seek starts at or near step 0 — the cases
      // the old iterate-from-startDate code also got right, so a regression in
      // either direction shows up here.
      [
        'weekly, window starting mid-cycle',
        { frequency: 'WEEKLY', interval: 1, startDate: c('2026-01-05') },
        '2026-01-20',
        '2026-03-31',
      ],
      [
        'fortnightly, window starting exactly on an occurrence',
        { frequency: 'WEEKLY', interval: 2, startDate: c('2026-01-05') },
        '2026-01-19',
        '2026-04-30',
      ],
      [
        'monthly on the 31st across two short months',
        { frequency: 'MONTHLY', interval: 1, dayOfMonth: 31, startDate: c('2026-01-31') },
        '2026-02-01',
        '2026-07-31',
      ],
      [
        'quarterly from an anchor before the window',
        { frequency: 'MONTHLY', interval: 3, dayOfMonth: 15, startDate: c('2025-01-15') },
        '2026-01-01',
        '2026-12-31',
      ],
      [
        'yearly on a leap-day anchor over a leap year',
        { frequency: 'YEARLY', interval: 1, startDate: c('2028-02-29') },
        '2028-01-01',
        '2032-12-31',
      ],
      [
        'yearly anchored to a month before the start month',
        { frequency: 'YEARLY', interval: 1, month: 3, dayOfMonth: 10, startDate: c('2026-06-15') },
        '2026-01-01',
        '2029-01-01',
      ],
      // Ancient start dates, where the seek does all the work. A short window
      // keeps the scan cheap while the seek has to jump thousands of steps.
      [
        'weekly from 1800',
        { frequency: 'WEEKLY', interval: 1, startDate: c('1800-01-05') },
        '2026-03-01',
        '2026-05-31',
      ],
      [
        'monthly from 1000 on the 31st',
        { frequency: 'MONTHLY', interval: 1, dayOfMonth: 31, startDate: c('1000-01-31') },
        '2026-01-01',
        '2026-12-31',
      ],
      [
        'yearly from 400 on a leap day',
        { frequency: 'YEARLY', interval: 1, startDate: c('0400-02-29') },
        '2024-01-01',
        '2029-12-31',
      ],
    ]

    it.each(cases)('matches for %s', (_label, rule, from, to) => {
      const reference = bruteForceDueDates(rule, c(from), c(to))

      expect(days(computeDueDates(rule, c(from), c(to)))).toEqual(reference)
      // Guards the guard: a reference that found nothing would make the
      // assertion above pass whatever the implementation did.
      expect(reference.length).toBeGreaterThan(0)
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
