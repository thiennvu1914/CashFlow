import { describe, expect, it, vi } from 'vitest'
import { formatDate } from './format-date'

const HCM = 'Asia/Ho_Chi_Minh'
/** 2026-09-08T17:30Z is 2026-09-09 00:30 in Ho Chi Minh City. */
const INSTANT = new Date('2026-09-08T17:30:00.000Z')

describe('formatDate', () => {
  it('reads an instant in the user’s zone, not the server’s', () => {
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'date' })).toBe('09/09/2026')
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: 'UTC', style: 'date' })).toBe('08/09/2026')
  })

  it('formats a date per locale', () => {
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'date' })).toBe('Sep 9, 2026')
  })

  it('formats a date and time', () => {
    // Node v24.16.0's ICU puts the time before the date for `vi-VN` at this
    // option set (`hh:mm dd/MM/yyyy`), not `dd/MM/yyyy, hh:mm` — observed,
    // not hand-built.
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'dateTime' })).toBe(
      '00:30 09/09/2026',
    )
  })

  it('formats a month and year for a page header', () => {
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'monthYear' })).toBe(
      'September 2026',
    )
  })

  it('reads a yyyy-MM-dd carrier as that calendar day everywhere', () => {
    // A `CalendarDate` carrier is UTC midnight by construction, so it must be
    // read in UTC and never shifted into the reader's zone — otherwise a due
    // date of the 9th displays as the 8th for anyone west of UTC.
    expect(formatDate('2026-09-09', { locale: 'vi', timeZone: HCM, style: 'date' })).toBe(
      '09/09/2026',
    )
    expect(
      formatDate('2026-09-09', { locale: 'en', timeZone: 'America/New_York', style: 'date' }),
    ).toBe('Sep 9, 2026')
  })

  it('formats a short month for a chart axis tick, in either locale', () => {
    // 2026-09-08T17:30Z is 2026-09-09 00:30 in Ho Chi Minh City — September.
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'monthShort' })).toBe('Sep')
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'monthShort' })).toBe(
      'Tháng 9',
    )
  })

  it('formats a short month and year for a comparison-chart bar label', () => {
    expect(formatDate(INSTANT, { locale: 'en', timeZone: HCM, style: 'monthYearShort' })).toBe(
      'Sep 2026',
    )
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'monthYearShort' })).toBe(
      'thg 9 2026',
    )
  })

  it('formats a weekday for a day-group header and a bare day/month for a compact row', () => {
    expect(formatDate('2026-09-09', { locale: 'en', timeZone: HCM, style: 'weekday' })).toContain(
      'Wednesday',
    )
    // Node v24.16.0's ICU separates `vi-VN` day/month with a dash, not a
    // slash, at this option set — observed, not hand-built.
    expect(formatDate('2026-09-09', { locale: 'vi', timeZone: HCM, style: 'dayMonth' })).toBe(
      '09-09',
    )
    expect(formatDate('2026-09-09', { locale: 'en', timeZone: HCM, style: 'dayMonth' })).toBe(
      'Sep 9',
    )
  })
})

describe('formatDate formatter cache', () => {
  // A zone no other test in this file uses, so the first call below is a
  // guaranteed cache miss whatever order the suite runs in.
  const ZONE = 'Pacific/Auckland'

  it('constructs one Intl.DateTimeFormat per (locale, options, timeZone) and returns identical strings', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
    try {
      const first = formatDate(INSTANT, { locale: 'vi', timeZone: ZONE, style: 'time' })
      for (let i = 0; i < 50; i++) {
        expect(formatDate(INSTANT, { locale: 'vi', timeZone: ZONE, style: 'time' })).toBe(first)
      }
      expect(spy).toHaveBeenCalledTimes(1)

      // Anything that changes the output is a different cache entry.
      formatDate(INSTANT, { locale: 'en', timeZone: ZONE, style: 'time' })
      formatDate(INSTANT, { locale: 'vi', timeZone: ZONE, style: 'date' })
      formatDate(INSTANT, { locale: 'vi', timeZone: 'Asia/Tokyo', style: 'time' })
      expect(spy).toHaveBeenCalledTimes(4)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps zones apart: a cached formatter never leaks another zone’s wall clock', () => {
    const tokyo = formatDate(INSTANT, { locale: 'vi', timeZone: 'Asia/Tokyo', style: 'time' })
    const hcm = formatDate(INSTANT, { locale: 'vi', timeZone: HCM, style: 'time' })
    expect(tokyo).toBe('02:30')
    expect(hcm).toBe('00:30')
    expect(formatDate(INSTANT, { locale: 'vi', timeZone: 'Asia/Tokyo', style: 'time' })).toBe(tokyo)
  })

  it('reads a calendar-date carrier in UTC through its own cache entry', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
    try {
      const a = formatDate('2026-09-09', {
        locale: 'en',
        timeZone: 'America/Denver',
        style: 'monthYearShort',
      })
      const b = formatDate('2026-09-09', {
        locale: 'en',
        timeZone: 'Asia/Tokyo',
        style: 'monthYearShort',
      })
      expect(a).toBe('Sep 2026')
      expect(b).toBe('Sep 2026')
      // Both carriers resolve to timeZone 'UTC', so they share one formatter.
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
