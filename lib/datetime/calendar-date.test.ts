import { describe, expect, it } from 'vitest'
import { CALENDAR_DATE_RE, isRealCalendarDate } from './calendar-date'

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
