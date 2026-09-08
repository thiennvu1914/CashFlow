import type ExcelJS from 'exceljs'
import { historicalAmountIn } from '@/lib/currency/historical-amount'
import { listTransactionsForExport } from '@/lib/server/services/transaction'
import {
  DATE_FMT,
  DATE_TIME_FMT,
  RATE_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  textCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/** One row exactly as the unbounded export query projects it. */
export type ExportTransactionRow = Awaited<ReturnType<typeof listTransactionsForExport>>[number]

/**
 * The Transactions sheet — the ledger itself, and the only sheet that appears in
 * both workbooks.
 *
 * It is written by one function taking already-fetched rows precisely so the
 * filtered and full exports cannot drift: they differ in *which* rows they pass
 * and in nothing else, so a column added here appears in both, formatted the
 * same way, or in neither.
 *
 * ## The two amount columns
 *
 * `Amount` is the native amount, in the row's own currency, exactly as stored —
 * it is never replaced by a converted value, because that number is what the
 * user actually spent. The display-currency column sits beside it and is
 * computed by `historicalAmountIn`, which restates the row at the rate *that
 * row* snapshotted at entry — not at today's rate. A March expense therefore
 * reads the same in an export taken today and one taken next year, however far
 * the rate has moved since. The snapshot itself is carried in the next three
 * columns so the conversion can be checked by hand.
 */
export function writeTransactionsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
  rows: ExportTransactionRow[],
): void {
  const sheet = workbook.addWorksheet('Transactions')
  const displayFmt = moneyFmt(ctx.displayCurrency)

  writeHeader(sheet, [
    // First, and deliberately: it is the only value on the row that identifies
    // it uniquely and permanently. Two coffees on the same day for the same
    // amount are otherwise indistinguishable, so a user reconciling a workbook
    // against the app — or against last month's workbook — has nothing to join
    // on without it.
    { header: 'Transaction id', width: 28 },
    { header: 'Date', width: 18 },
    { header: 'Type', width: 20 },
    { header: 'Category', width: 20 },
    { header: 'Account', width: 22 },
    { header: 'Amount', width: 16 },
    { header: 'Currency', width: 10 },
    { header: `Amount (${ctx.displayCurrency}, historical rate)`, width: 30 },
    { header: 'VND per USD at entry', width: 20 },
    { header: 'FX source', width: 22 },
    { header: 'FX effective (UTC day)', width: 22 },
    { header: 'FX fetched (local)', width: 20 },
    { header: 'Note', width: 40 },
  ])

  for (const row of rows) {
    const written = sheet.addRow([
      row.id,
      localDateCell(row.date, ctx.timezone),
      row.type,
      // Both optional, and `textCell` is what makes an absent one a blank cell
      // rather than an empty shared string Excel renders as a number.
      textCell(row.category?.name),
      row.account.name,
      moneyCell(row.amount),
      row.currency,
      moneyCell(historicalAmountIn(ctx.displayCurrency, row)),
      moneyCell(row.vndPerUsdAtEntry),
      row.fxRateSource,
      // The effective day is a UTC day by definition (it is the `ExchangeRate`
      // cache key), so it is shown as that day and not shifted into the user's
      // zone — shifting it would rename the rate's own day.
      localDateCell(row.fxRateEffectiveAt, 'UTC'),
      localDateCell(row.fxRateFetchedAt, ctx.timezone),
      textCell(row.note),
    ])
    written.getCell(2).numFmt = DATE_TIME_FMT
    // Formatted by the ROW's currency, not the user's: a USD row shows cents
    // even in a workbook whose display currency is VND.
    written.getCell(6).numFmt = moneyFmt(row.currency)
    written.getCell(8).numFmt = displayFmt
    written.getCell(9).numFmt = RATE_FMT
    written.getCell(11).numFmt = DATE_FMT
    written.getCell(12).numFmt = DATE_TIME_FMT
  }
}

/** The full export's Transactions sheet: the entire ledger, unbounded. */
export async function buildTransactionsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  writeTransactionsSheet(workbook, ctx, await listTransactionsForExport(ctx.userId))
}
