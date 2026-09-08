import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { formatChartValue, formatCompactAmount, formatMoney, formatRate } from './format-money'

/**
 * Pure formatting — no database, no session. Every expectation is the literal
 * Vietnamese grouping (`.` thousands, `,` decimals) both currencies are shown
 * with, because the separators follow the reader's locale while the number of
 * decimals follows the currency.
 */
describe('formatMoney', () => {
  it('shows VND whole — no minor unit means no ",00" padding', () => {
    expect(formatMoney(1234567, 'VND')).toBe('1.234.567')
    expect(formatMoney(0, 'VND')).toBe('0')
  })

  it('shows USD with exactly two decimals', () => {
    expect(formatMoney(100, 'USD')).toBe('100,00')
    expect(formatMoney(1234.5, 'USD')).toBe('1.234,50')
  })

  it('accepts a Prisma.Decimal, trailing zeros and all', () => {
    expect(formatMoney(new Prisma.Decimal('2500000.00'), 'VND')).toBe('2.500.000')
    expect(formatMoney(new Prisma.Decimal('12.34'), 'USD')).toBe('12,34')
  })

  it('is a display boundary, not a precision-preserving one', () => {
    // Documenting the known limit rather than pretending it away: this is where
    // a Decimal becomes a float, so a magnitude past 2^53 loses its last digits
    // *on screen*. Nothing reads this string back, and no realistic VND balance
    // reaches sixteen digits — but the day one does, it degrades here and
    // nowhere upstream, which is the whole point of confining `Number()` to
    // this one function.
    expect(formatMoney(new Prisma.Decimal('9007199254740993'), 'VND')).toBe('9.007.199.254.740.992')
  })

  it('keeps a VND amount that really does carry cents', () => {
    // A converted USD balance can land on a fraction of a dong; rounding it
    // away here would make the KPI disagree with the figure it came from.
    expect(formatMoney(new Prisma.Decimal('1234.50'), 'VND')).toBe('1.234,5')
  })

  it('renders negatives with a sign, in both currencies', () => {
    expect(formatMoney(new Prisma.Decimal('-2500000'), 'VND')).toBe('-2.500.000')
    expect(formatMoney(-0.5, 'USD')).toBe('-0,50')
  })
})

describe('formatRate', () => {
  it('groups a stored Decimal(18, 6) rate and trims it to two decimals', () => {
    expect(formatRate(new Prisma.Decimal('25000.500000'))).toBe('25.000,5')
    expect(formatRate(new Prisma.Decimal('26123.000000'))).toBe('26.123')
  })
})

/**
 * Recharts hands a tooltip formatter whatever is in the datum, typed as
 * `number | string | Array<number | string>`, so these cases are the shapes
 * that actually arrive rather than the ones we would prefer.
 */
describe('formatChartValue', () => {
  it('formats a plain number with its currency code', () => {
    expect(formatChartValue(1234567, 'VND')).toBe('1.234.567 VND')
    expect(formatChartValue(12.5, 'USD')).toBe('12,50 USD')
  })

  it('formats a numeric string', () => {
    expect(formatChartValue('2500000', 'VND')).toBe('2.500.000 VND')
  })

  it('reads an array datum at its first element', () => {
    // A stacked or range series yields `[from, to]`.
    expect(formatChartValue([1000, 2000], 'VND')).toBe('1.000 VND')
    expect(formatChartValue(['1000'], 'VND')).toBe('1.000 VND')
  })

  it('shows an em dash rather than a zero for anything unreadable', () => {
    // Never `0`: a tooltip reading "0 VND" over a gap in the balance line
    // would assert a measurement nobody took.
    expect(formatChartValue(Number.NaN, 'VND')).toBe('—')
    expect(formatChartValue(null, 'VND')).toBe('—')
    expect(formatChartValue(undefined, 'VND')).toBe('—')
    expect(formatChartValue('', 'VND')).toBe('—')
    expect(formatChartValue('not a number', 'VND')).toBe('—')
    expect(formatChartValue([], 'VND')).toBe('—')
    expect(formatChartValue(Number.POSITIVE_INFINITY, 'VND')).toBe('—')
    expect(formatChartValue({ nope: true }, 'VND')).toBe('—')
  })

  it('still formats a legitimate zero', () => {
    // A month with genuinely no expenses is 0, and must not be confused with
    // a month whose figure is unknown.
    expect(formatChartValue(0, 'VND')).toBe('0 VND')
  })
})

describe('formatCompactAmount', () => {
  it('abbreviates an axis tick', () => {
    // Intl separates the number from its scale suffix with a
    // non-breaking space (escaped here rather than pasted, because an
    // invisible U+00A0 in a source literal is a trap for the next reader).
    expect(formatCompactAmount(10_000_000)).toBe('10\u00a0Tr')
    expect(formatCompactAmount(-2_500_000)).toBe('-2,5\u00a0Tr')
  })
})

describe('locale-aware formatting', () => {
  it('groups with commas in English and dots in Vietnamese', () => {
    expect(formatMoney(25_000_000, 'VND', 'en')).toBe('25,000,000')
    expect(formatMoney(25_000_000, 'VND', 'vi')).toBe('25.000.000')
    expect(formatMoney(25_000_000, 'VND')).toBe('25.000.000')
  })

  it('keeps currency precision independent of the reader\u2019s locale', () => {
    expect(formatMoney(1234.5, 'USD', 'en')).toBe('1,234.50')
    expect(formatMoney(1234.5, 'USD', 'vi')).toBe('1.234,50')
  })

  it('formats a rate per locale', () => {
    expect(formatRate('25969.5', 'en')).toBe('25,969.5')
    expect(formatRate('25969.5', 'vi')).toBe('25.969,5')
  })

  it('formats a chart tooltip value per locale and still refuses a non-number', () => {
    expect(formatChartValue(1_500_000, 'VND', 'en')).toBe('1,500,000 VND')
    expect(formatChartValue(null, 'VND', 'en')).toBe('\u2014')
  })

  it('abbreviates an axis label in each locale\u2019s own short scale', () => {
    expect(formatCompactAmount(25_000_000, 'en')).toBe('25M')
    // Vietnamese compact notation is ICU-dependent; this is what this Node
    // emits. If it changes, change the expectation and note the version.
    expect(formatCompactAmount(25_000_000, 'vi')).toBe('25 Tr')
  })
})
