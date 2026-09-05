import { describe, it, expect } from 'vitest'
import { getPeriodBounds } from './period-bounds'

describe('getPeriodBounds', () => {
  it('computes month bounds in Asia/Ho_Chi_Minh (UTC+7)', () => {
    const ref = new Date('2026-03-15T10:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'month', ref)
    // 2026-03-01T00:00:00+07:00 == 2026-02-28T17:00:00Z
    expect(startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
    // 2026-04-01T00:00:00+07:00 == 2026-03-31T17:00:00Z (exclusive upper bound)
    expect(endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
  })

  it('uses Monday as the start of week regardless of the reference weekday', () => {
    // 2026-03-15 is a Sunday
    const ref = new Date('2026-03-15T10:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'week', ref)
    // Monday 2026-03-09T00:00:00+07:00 == 2026-03-08T17:00:00Z
    expect(startUtc.toISOString()).toBe('2026-03-08T17:00:00.000Z')
    // Next Monday 2026-03-16T00:00:00+07:00 == 2026-03-15T17:00:00Z
    expect(endUtc.toISOString()).toBe('2026-03-15T17:00:00.000Z')
  })

  it('is genuinely timezone-aware, not a hardcoded +7 offset (DST-observing zone)', () => {
    // 2026-07-15 is during US Eastern Daylight Time (UTC-4)
    const summerRef = new Date('2026-07-15T12:00:00Z')
    const summer = getPeriodBounds('America/New_York', 'day', summerRef)
    expect(summer.startUtc.toISOString()).toBe('2026-07-15T04:00:00.000Z')

    // 2026-01-15 is US Eastern Standard Time (UTC-5)
    const winterRef = new Date('2026-01-15T12:00:00Z')
    const winter = getPeriodBounds('America/New_York', 'day', winterRef)
    expect(winter.startUtc.toISOString()).toBe('2026-01-15T05:00:00.000Z')
  })

  it('computes quarter bounds', () => {
    const ref = new Date('2026-08-01T00:00:00Z') // Q3
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'quarter', ref)
    expect(startUtc.toISOString()).toBe('2026-06-30T17:00:00.000Z') // Jul 1 00:00 +07
    expect(endUtc.toISOString()).toBe('2026-09-30T17:00:00.000Z')   // Oct 1 00:00 +07
  })

  it('computes year bounds', () => {
    const ref = new Date('2026-08-01T00:00:00Z')
    const { startUtc, endUtc } = getPeriodBounds('Asia/Ho_Chi_Minh', 'year', ref)
    expect(startUtc.toISOString()).toBe('2025-12-31T17:00:00.000Z') // Jan 1 2026 00:00 +07
    expect(endUtc.toISOString()).toBe('2026-12-31T17:00:00.000Z')   // Jan 1 2027 00:00 +07
  })
})
