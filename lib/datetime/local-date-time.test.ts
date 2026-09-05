import { describe, expect, it } from 'vitest'
import {
  LOCAL_DATE_TIME_RE,
  instantToLocalDateTime,
  isRealLocalDateTime,
  localDateTimeToInstant,
  nowInZone,
} from './local-date-time'
import { createTransactionFormSchema } from '@/lib/validation/transaction'
import { createTransferFormSchema } from '@/lib/validation/transfer'

describe('LOCAL_DATE_TIME_RE', () => {
  it('matches what an <input type="datetime-local"> submits, with or without seconds', () => {
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05T09:15')).toBe(true)
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05T09:15:30')).toBe(true)
  })

  it('rejects a date with no time, a lone time, and loose formats', () => {
    // The old calendar-only shape is deliberately no longer acceptable: a
    // transaction now carries a time of day, and a bare day would silently
    // become midnight the user never entered.
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('09:15')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('2026-9-5T09:15')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05 09:15')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05T09:15:30.500')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('2026-09-05T09:15Z')).toBe(false)
    expect(LOCAL_DATE_TIME_RE.test('')).toBe(false)
  })
})

describe('isRealLocalDateTime', () => {
  it('accepts date-times that exist, including leap day and both ends of the clock', () => {
    expect(isRealLocalDateTime('2026-09-05T09:15')).toBe(true)
    expect(isRealLocalDateTime('2028-02-29T23:59')).toBe(true)
    expect(isRealLocalDateTime('2026-12-31T00:00')).toBe(true)
    expect(isRealLocalDateTime('2026-09-05T09:15:30')).toBe(true)
  })

  it('rejects well-formed strings that name no real date-time, and malformed strings', () => {
    expect(isRealLocalDateTime('2026-02-30T10:00')).toBe(false)
    expect(isRealLocalDateTime('2026-13-40T10:00')).toBe(false)
    expect(isRealLocalDateTime('2027-02-29T10:00')).toBe(false)
    // 24:00 is a legal ISO-8601 spelling of the next midnight, so a parser
    // silently rolls it into the following day. Rejected here rather than
    // stored as a day the user did not pick.
    expect(isRealLocalDateTime('2026-09-05T24:00')).toBe(false)
    expect(isRealLocalDateTime('2026-09-05T09:60')).toBe(false)
    expect(isRealLocalDateTime('2026-09-05')).toBe(false)
    expect(isRealLocalDateTime('')).toBe(false)
  })

  it('is enforced by the form schemas, so a non-existent date-time never reaches the action conversion', () => {
    const tx = createTransactionFormSchema.safeParse({
      accountId: 'a',
      type: 'CASH_IN',
      amount: 10,
      date: '2026-02-30T10:00',
    })
    expect(tx.success).toBe(false)
    const transfer = createTransferFormSchema.safeParse({
      fromAccountId: 'a',
      toAccountId: 'b',
      fromAmount: 10,
      toAmount: 10,
      date: '2026-09-05T24:00',
    })
    expect(transfer.success).toBe(false)
    // A date with no time is now invalid input too.
    expect(
      createTransactionFormSchema.safeParse({
        accountId: 'a',
        type: 'CASH_IN',
        amount: 10,
        date: '2026-09-05',
      }).success,
    ).toBe(false)
    expect(
      createTransactionFormSchema.safeParse({
        accountId: 'a',
        type: 'CASH_IN',
        amount: 10,
        date: '2026-09-05T09:15',
      }).success,
    ).toBe(true)
  })
})

describe('localDateTimeToInstant', () => {
  it('resolves the local date and time in Asia/Ho_Chi_Minh (UTC+7)', () => {
    expect(localDateTimeToInstant('2026-09-05T09:15', 'Asia/Ho_Chi_Minh').toISOString()).toBe(
      '2026-09-05T02:15:00.000Z',
    )
  })

  it('resolves the local date and time in America/New_York (UTC-4 in September)', () => {
    expect(localDateTimeToInstant('2026-09-05T18:45', 'America/New_York').toISOString()).toBe(
      '2026-09-05T22:45:00.000Z',
    )
  })

  it('resolves the local date and time unchanged in UTC, and keeps seconds when given', () => {
    expect(localDateTimeToInstant('2026-09-05T09:15', 'UTC').toISOString()).toBe(
      '2026-09-05T09:15:00.000Z',
    )
    expect(localDateTimeToInstant('2026-09-05T09:15:30', 'UTC').toISOString()).toBe(
      '2026-09-05T09:15:30.000Z',
    )
  })

  it('distinguishes two times on the same local day', () => {
    const morning = localDateTimeToInstant('2026-09-05T09:15', 'Asia/Ho_Chi_Minh')
    const evening = localDateTimeToInstant('2026-09-05T18:45', 'Asia/Ho_Chi_Minh')
    expect(morning.toISOString()).toBe('2026-09-05T02:15:00.000Z')
    expect(evening.toISOString()).toBe('2026-09-05T11:45:00.000Z')
    expect(evening.getTime()).toBeGreaterThan(morning.getTime())
  })

  it('rejects a malformed value', () => {
    expect(() => localDateTimeToInstant('2026-09-05', 'UTC')).toThrow(
      'Expected a yyyy-MM-ddTHH:mm local date and time',
    )
    expect(() => localDateTimeToInstant('', 'UTC')).toThrow(
      'Expected a yyyy-MM-ddTHH:mm local date and time',
    )
  })

  it('rejects a well-formed but non-existent date-time instead of rolling it over', () => {
    expect(() => localDateTimeToInstant('2026-02-30T10:00', 'UTC')).toThrow(
      'not a real local date and time',
    )
    expect(() => localDateTimeToInstant('2026-09-05T24:00', 'UTC')).toThrow(
      'not a real local date and time',
    )
    expect(() => localDateTimeToInstant('2026-13-40T10:00', 'UTC')).toThrow(
      'not a real local date and time',
    )
  })
})

describe('instantToLocalDateTime', () => {
  it('reads the instant back in the given zone, to the minute', () => {
    const instant = new Date('2026-09-05T02:15:00.000Z')
    expect(instantToLocalDateTime(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-09-05T09:15')
    // The same instant is a different local day and time in UTC — which is
    // exactly what this conversion exists to make explicit.
    expect(instantToLocalDateTime(instant, 'UTC')).toBe('2026-09-05T02:15')
  })
})

describe('round trip', () => {
  // `2026-03-08` is the US spring-forward day and `2026-11-01` the fall-back
  // day; `2026-04-05` is Sydney's. The times chosen exist in every one of them
  // (a DST gap is a separate concern — see `localDateTimeToInstant`).
  const cases: Array<[string, string]> = [
    ['Asia/Ho_Chi_Minh', '2026-09-05T09:15'],
    ['Asia/Ho_Chi_Minh', '2026-01-01T00:00'],
    ['America/New_York', '2026-03-08T12:30'],
    ['America/New_York', '2026-11-01T12:30'],
    ['Australia/Sydney', '2026-04-05T12:30'],
    ['UTC', '2026-12-31T23:59'],
    ['Pacific/Kiritimati', '2026-06-15T18:45'],
  ]

  it.each(cases)(
    '%s / %s survives local date-time → instant → local date-time',
    (timezone, value) => {
      expect(instantToLocalDateTime(localDateTimeToInstant(value, timezone), timezone)).toBe(value)
    },
  )
})

describe('nowInZone', () => {
  it('reports the local date and time in a zone ahead of UTC', () => {
    // 2026-09-05T22:30:00Z is already 2026-09-06 05:30 in Ho Chi Minh City.
    const now = new Date('2026-09-05T22:30:00Z')
    expect(nowInZone('Asia/Ho_Chi_Minh', now)).toBe('2026-09-06T05:30')
  })

  it('matches the UTC clock for the UTC zone itself', () => {
    const now = new Date('2026-09-05T22:30:00Z')
    expect(nowInZone('UTC', now)).toBe('2026-09-05T22:30')
  })

  it('defaults to the real current instant, in the shape a datetime-local input needs', () => {
    expect(nowInZone('UTC')).toMatch(LOCAL_DATE_TIME_RE)
  })
})
