import { describe, expect, it } from 'vitest'
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
