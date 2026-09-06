import { describe, expect, it } from 'vitest'
import { getRecentMonthWindows } from './month-windows'

/**
 * Pure date arithmetic — no database, no clock: every case pins `now`.
 *
 * The property under test throughout is that the months are the *user's* local
 * ones. The same instant belongs to different months for a user ahead of UTC
 * and one behind it, and the window boundaries follow the local calendar, not
 * midnight UTC.
 */

const HCMC = 'Asia/Ho_Chi_Minh'
const NEW_YORK = 'America/New_York'

describe('getRecentMonthWindows', () => {
  it('returns no windows for a non-positive monthsBack', () => {
    expect(getRecentMonthWindows(HCMC, 0, new Date('2026-09-15T10:00:00.000Z'))).toEqual([])
    expect(getRecentMonthWindows(HCMC, -1, new Date('2026-09-15T10:00:00.000Z'))).toEqual([])
  })

  it('steps back across a year boundary, oldest first', () => {
    // 2026-01-10 10:00 local in Ho Chi Minh City.
    const now = new Date('2026-01-10T03:00:00.000Z')

    const windows = getRecentMonthWindows(HCMC, 3, now)

    expect(windows.map((window) => window.month)).toEqual(['2025-11', '2025-12', '2026-01'])
    // Local month starts, expressed in UTC: +07 puts them at 17:00 on the last
    // day of the preceding UTC month.
    expect(windows[0].startUtc.toISOString()).toBe('2025-10-31T17:00:00.000Z')
    expect(windows[2].startUtc.toISOString()).toBe('2025-12-31T17:00:00.000Z')
    expect(windows[2].endUtc.toISOString()).toBe('2026-01-31T17:00:00.000Z')
  })

  it('labels the same instant differently for a zone ahead of and behind UTC', () => {
    // 2026-09-01 09:00 in Ho Chi Minh City is still 2026-08-31 22:00 in New York.
    const now = new Date('2026-09-01T02:00:00.000Z')

    const ahead = getRecentMonthWindows(HCMC, 1, now)
    const behind = getRecentMonthWindows(NEW_YORK, 1, now)

    expect(ahead[0].month).toBe('2026-09')
    expect(ahead[0].startUtc.toISOString()).toBe('2026-08-31T17:00:00.000Z')
    expect(ahead[0].endUtc.toISOString()).toBe('2026-09-30T17:00:00.000Z')

    expect(behind[0].month).toBe('2026-08')
    // EDT is UTC−4, so local midnight is 04:00Z — and the month's end lands on
    // the *following* UTC day, 2026-09-01.
    expect(behind[0].startUtc.toISOString()).toBe('2026-08-01T04:00:00.000Z')
    expect(behind[0].endUtc.toISOString()).toBe('2026-09-01T04:00:00.000Z')
  })

  it('produces contiguous windows with no gap or overlap, across a DST change', () => {
    // Twelve months ending in October 2026 covers both New York transitions
    // (March forward, November back), so a naive fixed-offset calculation would
    // leave an hour-wide seam somewhere in the chain.
    const windows = getRecentMonthWindows(NEW_YORK, 12, new Date('2026-10-20T15:00:00.000Z'))

    expect(windows).toHaveLength(12)
    expect(windows[0].month).toBe('2025-11')
    expect(windows[11].month).toBe('2026-10')
    for (let i = 0; i < windows.length - 1; i++) {
      // `endUtc` is exclusive, so it is exactly where the next window begins.
      expect(windows[i].endUtc.getTime()).toBe(windows[i + 1].startUtc.getTime())
      expect(windows[i].startUtc.getTime()).toBeLessThan(windows[i].endUtc.getTime())
    }
  })
})
