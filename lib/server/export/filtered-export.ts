import ExcelJS from 'exceljs'
import { describeRange, type ReportRange } from '@/lib/reports/report-range'
import { getActivitySummary } from '@/lib/server/services/activity'
import { listTransactionsForExport } from '@/lib/server/services/transaction'
import { moneyCell, moneyFmt } from './cells'
import { writeTransactionsSheet } from './build-transactions-sheet'
import type { ExportContext } from './sheet-registry'

/**
 * The filtered workbook: one window of history, exactly the window the Reports
 * page was showing.
 *
 * It takes an **already-resolved** `ReportRange` rather than query parameters,
 * which is the whole point of the shape. The page and the export route both
 * call the single `resolveReportRange`, and the range object then travels here
 * untouched — so the spreadsheet cannot silently re-derive "this month" a second
 * time and disagree with the page at a boundary, and the builder is testable
 * without a session or a browser.
 *
 * Every figure is historical: `getActivitySummary` restates each row at the rate
 * that row snapshotted at entry, so this workbook answers the same numbers next
 * year and is unaffected by an FX outage. Nothing here reads `ctx.fx`.
 *
 * The Transactions sheet is written by `writeTransactionsSheet` — the same
 * function the full export uses — so the two workbooks' ledgers cannot drift
 * apart in columns, formats or conversion rule.
 */
export async function buildFilteredWorkbook(
  ctx: ExportContext,
  range: ReportRange,
): Promise<ExcelJS.Workbook> {
  const [summary, rows] = await Promise.all([
    getActivitySummary(ctx.userId, ctx.displayCurrency, range),
    listTransactionsForExport(ctx.userId, range),
  ])

  const workbook = new ExcelJS.Workbook()
  writeSummarySheet(workbook, ctx, range, summary)
  writeTransactionsSheet(workbook, ctx, rows)
  return workbook
}

type ActivitySummary = Awaited<ReturnType<typeof getActivitySummary>>

/**
 * The cover sheet: which window, then the totals, then the same two breakdowns
 * the Reports page shows.
 *
 * Both the human-readable range and the raw UTC bounds are written. The labels
 * are the *inclusive* local days the report covers — "1 Mar – 31 Mar", the same
 * two dates the page's header shows — while the bounds are the half-open
 * `[startUtc, endUtc)` the query actually ran with, so anyone reconciling a row
 * near a boundary can see exactly where the cut fell.
 */
function writeSummarySheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
  range: ReportRange,
  summary: ActivitySummary,
): void {
  const sheet = workbook.addWorksheet('Summary')
  sheet.columns = [{ width: 28 }, { width: 22 }, { width: 18 }, { width: 18 }]
  const displayFmt = moneyFmt(ctx.displayCurrency)
  const { fromLabel, toLabelInclusive } = describeRange(range, ctx.timezone)

  sheet.addRow(['Range from', fromLabel])
  // The inclusive last day, never `endUtc`'s local date — that names the day
  // *after* the one the report covers.
  sheet.addRow(['Range to', toLabelInclusive])
  sheet.addRow(['Period', range.kind])
  sheet.addRow(['Timezone', ctx.timezone])
  sheet.addRow(['Display currency', ctx.displayCurrency])
  sheet.addRow(['Range start (UTC)', range.startUtc.toISOString()])
  sheet.addRow(['Range end (UTC, exclusive)', range.endUtc.toISOString()])
  sheet.addRow([])

  for (const [label, value] of [
    ['Income', summary.income],
    // A positive magnitude — the direction is carried by the label, never by a
    // sign, exactly as the aggregate produces it.
    ['Expense', summary.expense],
    ['Net Income', summary.netIncome],
  ] as const) {
    const row = sheet.addRow([label, moneyCell(value)])
    row.getCell(2).numFmt = displayFmt
  }

  sheet.addRow([])
  heading(sheet, 'By category')
  heading(sheet, ['Category', 'Expense'])
  if (summary.byCategory.length === 0) {
    sheet.addRow(['No expenses in this range'])
  }
  for (const category of summary.byCategory) {
    const row = sheet.addRow([category.name, moneyCell(category.total)])
    row.getCell(2).numFmt = displayFmt
  }

  sheet.addRow([])
  heading(sheet, 'By account')
  heading(sheet, ['Account', 'Income', 'Expense', 'Net income'])
  if (summary.byAccount.length === 0) {
    sheet.addRow(['No activity in this range'])
  }
  for (const account of summary.byAccount) {
    // Three figures per account, never one unsigned total: "500" against an
    // account says nothing about whether money came in or went out.
    const row = sheet.addRow([
      account.name,
      moneyCell(account.income),
      moneyCell(account.expense),
      moneyCell(account.netIncome),
    ])
    for (const index of [2, 3, 4]) row.getCell(index).numFmt = displayFmt
  }
}

/** A bold section title or column header inside the label/value sheet. */
function heading(sheet: ExcelJS.Worksheet, values: string | string[]): void {
  const row = sheet.addRow(Array.isArray(values) ? values : [values])
  row.font = { bold: true }
}
