import type { Prisma } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'

/**
 * The presentation boundary for money.
 *
 * Everything upstream of this file is `Prisma.Decimal`; this is where a figure
 * stops being an amount and becomes a string on a screen. It is deliberately
 * the *only* place a money value is handed to `Number`, and nothing it returns
 * is ever read back into a calculation.
 *
 * Grouping is Vietnamese in both currencies (`1.234.567,89`) because the
 * separators belong to the reader's locale, not to the money's: a Vietnamese
 * user reading a USD balance still reads "." as thousands. Precision, on the
 * other hand, belongs to the currency — VND has no minor unit, so a whole
 * number of dong is shown whole rather than padded with a meaningless ",00".
 */

/** How many decimals each currency shows when the amount has none of its own. */
const MIN_FRACTION_DIGITS: Record<Currency, number> = { VND: 0, USD: 2 }

/**
 * `maximumFractionDigits` is 2 for both: stored amounts are `Decimal(18, 2)`,
 * so two is all there ever is to show, and a VND amount that genuinely carries
 * cents (a converted USD figure, say) shows them rather than being silently
 * rounded away.
 */
const MAX_FRACTION_DIGITS = 2

const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  VND: new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: MIN_FRACTION_DIGITS.VND,
    maximumFractionDigits: MAX_FRACTION_DIGITS,
  }),
  USD: new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: MIN_FRACTION_DIGITS.USD,
    maximumFractionDigits: MAX_FRACTION_DIGITS,
  }),
}

/**
 * `value` formatted for display in `currency`. No currency symbol or code is
 * appended — the caller decides whether the unit belongs beside each figure or
 * once in a heading.
 *
 * Accepts a `Decimal`, the string it serialises to, or a plain number, because
 * a chart tooltip only ever has the number the page already converted for the
 * chart and re-widening it to a Decimal to format it would be theatre.
 */
export function formatMoney(value: Prisma.Decimal | string | number, currency: Currency): string {
  // The one sanctioned `Number()` on a money value in the codebase. `String()`
  // first so a `Decimal` goes through its own exact serialisation rather than
  // `valueOf`, and so the same code path handles all three input shapes.
  return FORMATTERS[currency].format(Number(String(value)))
}

/** Stands in for a figure that does not exist or cannot be read as a number. */
const NO_VALUE = '—'

/**
 * A recharts tooltip value, formatted with its currency code.
 *
 * Recharts types a datum as `ValueType = number | string | Array<number |
 * string>` and hands it to the formatter as-is, so the tooltip callbacks take
 * `unknown` and normalise here rather than each doing its own `Number(value)`
 * — which is what keeps every money-to-float coercion in this one file.
 *
 * An array (what a stacked or range series yields) is read at its first
 * element; anything that does not resolve to a finite number — `null`, an
 * `undefined` datum, a label recharts passed through, `NaN` — becomes an em
 * dash. It must never become `0`: a tooltip reading "0 VND" over a gap in the
 * balance line would assert a measurement nobody took.
 */
export function formatChartValue(value: unknown, currency: Currency): string {
  const scalar = Array.isArray(value) ? value[0] : value
  if (scalar === null || scalar === undefined || scalar === '') return NO_VALUE
  if (typeof scalar !== 'number' && typeof scalar !== 'string') return NO_VALUE
  const asNumber = Number(scalar)
  if (!Number.isFinite(asNumber)) return NO_VALUE
  return `${FORMATTERS[currency].format(asNumber)} ${currency}`
}

/**
 * An FX rate for display — always VND per 1 USD, so it is grouped like a VND
 * figure but keeps up to two decimals of the stored `Decimal(18, 6)`. Rates are
 * quoted, never spent: this is not `formatMoney` because a rate is not an
 * amount of money in a currency, and rounding rules for the two differ.
 */
const RATE_FORMATTER = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 })

export function formatRate(rate: Prisma.Decimal | string | number): string {
  return RATE_FORMATTER.format(Number(String(rate)))
}

/**
 * A chart axis tick: the same figure, abbreviated, because "10.000.000" repeated
 * down a Y axis is a wall of digits that says less than "10 Tr" does. Compact
 * notation is a *label*, never a value — the tooltip and every KPI still show
 * `formatMoney`'s exact figure.
 */
const COMPACT_FORMATTER = new Intl.NumberFormat('vi-VN', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatCompactAmount(value: number): string {
  return COMPACT_FORMATTER.format(value)
}
