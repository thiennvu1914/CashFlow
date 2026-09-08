import type { Prisma } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from '@/lib/i18n/locale'
import enCommon from '@/messages/en/common.json'
import viCommon from '@/messages/vi/common.json'

/**
 * The presentation boundary for money.
 *
 * Everything upstream of this file is `Prisma.Decimal`; this is where a figure
 * stops being an amount and becomes a string on a screen. It is deliberately
 * the *only* place a money value is handed to `Number`, and nothing it returns
 * is ever read back into a calculation.
 *
 * Grouping follows the READER's locale (spec §4, open decision 1): `vi-VN`
 * gives `1.234.567,89` and `en-US` gives `1,234,567.89`. Precision still
 * belongs to the currency — VND has no minor unit, so a whole number of dong
 * is shown whole rather than padded with a meaningless ",00".
 *
 * `locale` is the LAST parameter and defaults to `vi`, deliberately: every
 * pre-Phase-7 caller — and every Phase 2–6 test asserting Vietnamese grouping —
 * keeps working untouched, and a caller that knows the reader's locale passes
 * it. Task 13 threads it through the view models.
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

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return new Intl.NumberFormat(INTL_LOCALE[locale], options)
}

const FORMATTERS: Record<Locale, Record<Currency, Intl.NumberFormat>> = {
  vi: {
    VND: numberFormat('vi', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.VND,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
    USD: numberFormat('vi', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.USD,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
  },
  en: {
    VND: numberFormat('en', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.VND,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
    USD: numberFormat('en', {
      minimumFractionDigits: MIN_FRACTION_DIGITS.USD,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
    }),
  },
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
export function formatMoney(
  value: Prisma.Decimal | string | number,
  currency: Currency,
  locale: Locale = DEFAULT_LOCALE,
): string {
  // The one sanctioned `Number()` on a money value in the codebase. `String()`
  // first so a `Decimal` goes through its own exact serialisation rather than
  // `valueOf`, and so the same code path handles all three input shapes.
  return FORMATTERS[locale][currency].format(Number(String(value)))
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
export function formatChartValue(
  value: unknown,
  currency: Currency,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const scalar = Array.isArray(value) ? value[0] : value
  if (scalar === null || scalar === undefined || scalar === '') return NO_VALUE
  if (typeof scalar !== 'number' && typeof scalar !== 'string') return NO_VALUE
  const asNumber = Number(scalar)
  if (!Number.isFinite(asNumber)) return NO_VALUE
  return `${FORMATTERS[locale][currency].format(asNumber)} ${currency}`
}

/**
 * An FX rate for display — always VND per 1 USD, so it is grouped like a VND
 * figure but keeps up to two decimals of the stored `Decimal(18, 6)`. Rates are
 * quoted, never spent: this is not `formatMoney` because a rate is not an
 * amount of money in a currency, and rounding rules for the two differ.
 */
const RATE_FORMATTERS: Record<Locale, Intl.NumberFormat> = {
  vi: numberFormat('vi', { maximumFractionDigits: 2 }),
  en: numberFormat('en', { maximumFractionDigits: 2 }),
}

export function formatRate(
  rate: Prisma.Decimal | string | number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return RATE_FORMATTERS[locale].format(Number(String(rate)))
}

/**
 * `common.rateLine`'s own template ("1 {from} = {rate} {to}"), read directly
 * off the message files rather than duplicated as a literal here — the two
 * can never drift apart, and this module has no `next-intl` context to call
 * `t()` with (it is imported by both server and client code, `TransferList`
 * and `TransferForm` alike).
 */
const RATE_LINE_TEMPLATES: Record<Locale, string> = { vi: viCommon.rateLine, en: enCommon.rateLine }

/**
 * A transfer's rate, quoted the way a person reads it — always USD-per-1,
 * e.g. "1 USD = 25.000 VND", never "1 VND = 0,00004 USD" — regardless of
 * which currency the transfer actually moved FROM.
 *
 * `exchangeRateUsed` (or, for `TransferForm`'s live preview, the ratio of the
 * two amounts the user has typed so far) is stored/derived destination-per-
 * source: a VND→USD transfer's rate is USD-per-VND, e.g. 0.00004. Printing
 * that verbatim is technically true and useless — nobody quotes the dong
 * that way — so the pair is normalised to USD-per-1 and the reciprocal is
 * taken whenever the source account is NOT USD. This function only
 * reformats that stored/derived figure for display; it never computes a new
 * rate, and nothing it returns is read back into a calculation.
 *
 * Shared by `TransferList` (the historical `exchangeRateUsed`) and
 * `TransferForm` (a live preview ratio, same shape) so the two can never
 * quote the same pair in different directions.
 */
export function formatReadableRate(
  fromCurrency: Currency,
  toCurrency: Currency,
  rateUsed: Prisma.Decimal | string | number | null,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  if (rateUsed === null) return null
  const sourceIsUsd = fromCurrency === 'USD'
  const rate = sourceIsUsd ? Number(String(rateUsed)) : 1 / Number(String(rateUsed))
  const [from, to] = sourceIsUsd ? [fromCurrency, toCurrency] : [toCurrency, fromCurrency]
  return RATE_LINE_TEMPLATES[locale]
    .replace('{from}', from)
    .replace('{rate}', formatRate(rate, locale))
    .replace('{to}', to)
}

/**
 * A chart axis tick: the same figure, abbreviated, because "10.000.000" repeated
 * down a Y axis is a wall of digits that says less than "10 Tr" does. Compact
 * notation is a *label*, never a value — the tooltip and every KPI still show
 * `formatMoney`'s exact figure.
 */
const COMPACT_FORMATTERS: Record<Locale, Intl.NumberFormat> = {
  vi: numberFormat('vi', { notation: 'compact', maximumFractionDigits: 1 }),
  en: numberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }),
}

export function formatCompactAmount(value: number, locale: Locale = DEFAULT_LOCALE): string {
  return COMPACT_FORMATTERS[locale].format(value)
}
