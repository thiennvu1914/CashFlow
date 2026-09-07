import type { Prisma } from '@prisma/client'
import type ExcelJS from 'exceljs'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'

/**
 * The boundary between CashFlow's money model and a spreadsheet cell.
 *
 * Everything a sheet writes goes through this module, for two reasons that both
 * come down to fidelity.
 *
 * **Decimals.** Every amount is a `Prisma.Decimal` right up to the moment it
 * becomes a cell, because Excel has no decimal type — a cell value is an IEEE
 * double or it is text, and text cannot be summed. `moneyCell` (for an amount)
 * and `percentCell` (for a ratio) are therefore the only `toNumber()` calls in
 * the export, so there is a single file to look at when asking where precision
 * could have been lost, and no intermediate arithmetic happens on the far side
 * of either.
 *
 * **Instants.** Excel has no timezone either: a date cell is a serial number of
 * days since 1900, and whatever wall clock that serial encodes is what the
 * reader sees. ExcelJS derives that serial straight from `Date#getTime()`
 * (`dateToExcel` in `exceljs/lib/utils/utils.js`), i.e. from the instant's *UTC*
 * components. Writing the stored instant would therefore show a Vietnamese
 * user's 12:00 lunch as 05:00. `localDateCell` instead builds a `Date` whose UTC
 * components *are* the user's local wall clock, so the spreadsheet displays the
 * time the user actually entered. Such a value is a display carrier, never an
 * instant — nothing may do date arithmetic with it.
 */

/** Date + time of day, for a transaction or transfer's own moment. */
export const DATE_TIME_FMT = 'yyyy-mm-dd hh:mm'

/** Date only, for a day-granular fact (an FX effective day, an opening date). */
export const DATE_FMT = 'yyyy-mm-dd'

/** An FX rate keeps all six of `Decimal(18, 6)`'s fractional digits, so a
 *  converted column can be reconciled against the rate that produced it. */
export const RATE_FMT = '#,##0.000000'

/**
 * The number format for money in `currency`.
 *
 * VND has no subunit in practice — its smallest circulating denomination is
 * larger than one đồng — so showing "1.000.000,00" would be two digits of false
 * precision on every row. USD keeps its cents.
 */
export function moneyFmt(currency: Currency): string {
  return currency === 'VND' ? '#,##0' : '#,##0.00'
}

/**
 * `instant` as a spreadsheet date cell showing the user's local wall clock.
 *
 * The components are read in `timezone` and reassembled as UTC — see the module
 * comment for why that is the correct thing to hand ExcelJS.
 */
export function localDateCell(instant: Date, timezone: string): Date {
  const [year, month, day, hour, minute, second] = formatInTimeZone(
    instant,
    timezone,
    'yyyy-MM-dd-HH-mm-ss',
  )
    .split('-')
    .map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

/**
 * A `Decimal` as a cell value.
 *
 * THE one `toNumber()` boundary of the whole export: every amount stays a
 * `Decimal` through balance derivation, FX conversion and aggregation, and is
 * widened to a double only here, on its way into a cell that cannot hold
 * anything else.
 */
export function moneyCell(value: Prisma.Decimal): number {
  return value.toNumber()
}

/** The number format for a `percentCell`: Excel renders the fraction as a whole percent. */
export const PERCENT_FMT = '0%'

/**
 * A `Decimal` ratio (1 = 100 %) as a percentage cell value.
 *
 * Excel's percentage cells hold the *fraction* and apply `PERCENT_FMT` for
 * display, so the unrounded ratio is widened here and the spreadsheet does the
 * rounding on screen. Nothing recomputes from the result — a status band that
 * depends on the ratio is classified on the `Decimal` before it reaches a cell.
 */
export function percentCell(ratio: Prisma.Decimal): number {
  return ratio.toNumber()
}

/**
 * The same, for a figure that may genuinely have no value — a balance whose
 * conversion needs an exchange rate we do not have.
 *
 * `null` leaves the cell empty. A zero would read as "this account holds
 * nothing" and a `1` rate would be a fabricated number; an empty cell is the
 * only honest answer, and the sheet says why in a neighbouring column.
 */
export function optionalMoneyCell(value: Prisma.Decimal | null): number | null {
  return value === null ? null : moneyCell(value)
}

/** One column's header text and rendered width. */
export interface ColumnSpec {
  header: string
  width: number
}

/**
 * Writes the header row and fixes the sheet's shape: bold headers, sensible
 * column widths, and the header frozen so it stays visible while scrolling a
 * ledger that can run to thousands of rows.
 */
export function writeHeader(sheet: ExcelJS.Worksheet, columns: ColumnSpec[]): void {
  sheet.columns = columns.map((column) => ({ width: column.width }))
  const header = sheet.addRow(columns.map((column) => column.header))
  header.font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}
