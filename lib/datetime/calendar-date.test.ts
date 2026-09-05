import { describe, expect, it } from 'vitest'
import {
  CALENDAR_DATE_RE,
  calendarDateToInstant,
  instantToCalendarDate,
  isRealCalendarDate,
} from './calendar-date'
import { createTransactionFormSchema } from '@/lib/validation/transaction'
import { createTransferFormSchema } from '@/lib/validation/transfer'

describe('CALENDAR_DATE_RE', () => {
  it('matches a yyyy-MM-dd string only', () => {
    expect(CALENDAR_DATE_RE.test('2026-09-05')).toBe(true)
    expect(CALENDAR_DATE_RE.test('2026-9-5')).toBe(false)
    expect(CALENDAR_DATE_RE.test('05/09/2026')).toBe(false)
    expect(CALENDAR_DATE_RE.test('2026-09-05T00:00:00Z')).toBe(false)
    expect(CALENDAR_DATE_RE.test('')).toBe(false)
  })
})

describe('isRealCalendarDate', () => {
  it('accepts days that exist, including leap day', () => {
    expect(isRealCalendarDate('2026-09-05')).toBe(true)
    expect(isRealCalendarDate('2028-02-29')).toBe(true)
    expect(isRealCalendarDate('2026-12-31')).toBe(true)
  })

  it('rejects well-formed strings that name no real day, and malformed strings', () => {
    expect(isRealCalendarDate('2026-02-30')).toBe(false)
    expect(isRealCalendarDate('2026-13-40')).toBe(false)
    expect(isRealCalendarDate('2027-02-29')).toBe(false)
    expect(isRealCalendarDate('2026-9-5')).toBe(false)
    expect(isRealCalendarDate('')).toBe(false)
  })

  it('is enforced by the form schemas, so a non-existent date never reaches the action conversion', () => {
    const tx = createTransactionFormSchema.safeParse({
      accountId: 'a',
      type: 'CASH_IN',
      amount: 10,
      date: '2026-02-30',
    })
    expect(tx.success).toBe(false)
    const transfer = createTransferFormSchema.safeParse({
      fromAccountId: 'a',
      toAccountId: 'b',
      fromAmount: 10,
      toAmount: 10,
      date: '2026-13-40',
    })
    expect(transfer.success).toBe(false)
    expect(
      createTransactionFormSchema.safeParse({
        accountId: 'a',
        type: 'CASH_IN',
        amount: 10,
        date: '2026-09-05',
      }).success,
    ).toBe(true)
  })
})

describe('calendarDateToInstant', () => {
  it('resolves the calendar day to local midnight in Asia/Ho_Chi_Minh (UTC+7)', () => {
    expect(calendarDateToInstant('2026-09-05', 'Asia/Ho_Chi_Minh').toISOString()).toBe(
      '2026-09-04T17:00:00.000Z',
    )
  })

  it('resolves the calendar day to local midnight in America/New_York (UTC-4 in September)', () => {
    expect(calendarDateToInstant('2026-09-05', 'America/New_York').toISOString()).toBe(
      '2026-09-05T04:00:00.000Z',
    )
  })

  it('resolves the calendar day to plain midnight in UTC', () => {
    expect(calendarDateToInstant('2026-09-05', 'UTC').toISOString()).toBe(
      '2026-09-05T00:00:00.000Z',
    )
  })

  it('rejects a malformed date string', () => {
    expect(() => calendarDateToInstant('2026-9-5', 'UTC')).toThrow(
      'Expected a yyyy-MM-dd calendar date',
    )
    expect(() => calendarDateToInstant('', 'UTC')).toThrow('Expected a yyyy-MM-dd calendar date')
  })

  it('rejects a well-formed but non-existent calendar date instead of rolling it over', () => {
    expect(() => calendarDateToInstant('2026-13-40', 'UTC')).toThrow('not a real calendar date')
    expect(() => calendarDateToInstant('2026-02-30', 'UTC')).toThrow('not a real calendar date')
  })
})

describe('instantToCalendarDate', () => {
  it('reads the instant back in the given zone', () => {
    const instant = new Date('2026-09-04T17:00:00.000Z')
    expect(instantToCalendarDate(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-09-05')
    // The same instant is still the 4th in UTC — which is exactly the
    // off-by-one this convention exists to make explicit.
    expect(instantToCalendarDate(instant, 'UTC')).toBe('2026-09-04')
  })
})

describe('round trip', () => {
  // `2026-03-08` is the US spring-forward day (02:00 → 03:00 local); local
  // midnight still exists there, so the round trip must survive it. The
  // Australian and Vietnamese zones cover a +11/+7 offset either side of UTC.
  const cases: Array<[string, string]> = [
    ['Asia/Ho_Chi_Minh', '2026-09-05'],
    ['Asia/Ho_Chi_Minh', '2026-01-01'],
    ['America/New_York', '2026-03-08'],
    ['America/New_York', '2026-11-01'],
    ['Australia/Sydney', '2026-04-05'],
    ['UTC', '2026-12-31'],
    ['Pacific/Kiritimati', '2026-06-15'],
  ]

  it.each(cases)('%s / %s survives instant → calendar date → instant', (timezone, date) => {
    expect(instantToCalendarDate(calendarDateToInstant(date, timezone), timezone)).toBe(date)
  })
})
