import type { DebtDirection } from '@prisma/client'
import type ExcelJS from 'exceljs'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getDebtsWithOutstanding } from '@/lib/server/services/debt'
import { DEBT_STATUS_LABELS } from '@/lib/ui/debt-view-model'
import { DATE_FMT, DATE_TIME_FMT, localDateCell, moneyCell, moneyFmt, writeHeader } from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The ledger's own words for a direction, deliberately not the Debts page's
 * "Owes you" / "You owe".
 *
 * The page addresses the user directly, in a badge next to a person's name. A
 * spreadsheet column is read the other way round — sorted, filtered and pivoted
 * — and "Owes you" sorts under O while "You owe" sorts under Y, which puts the
 * two halves of the same question at opposite ends of a sort. `Receivable` and
 * `Payable` are also the words a reader importing this file into their own
 * bookkeeping already uses.
 */
export const DEBT_DIRECTION_EXPORT_LABELS: Record<DebtDirection, string> = {
  RECEIVABLE: 'Receivable',
  PAYABLE: 'Payable',
}

/**
 * The Debts sheet — every debt the user tracks, with what is still owed on it
 * (spec §4.9, §12).
 *
 * ## History is never omitted
 *
 * `getDebtsWithOutstanding` is called without `activeOnly`, so a WRITTEN_OFF
 * debt is on this sheet with `Status` saying so and its `Outstanding` left
 * exactly as it stands — not zeroed. Writing a debt off records a decision ("I
 * am never getting this back"); it does not make the money never have been owed,
 * and the Summary sheet's Net Worth is the one figure that excludes it. Rows come
 * out live debts first and written-off ones last, the order the Debts page
 * renders.
 *
 * ## Each debt in its OWN currency, and no rate anywhere
 *
 * `Original`, `Paid` and `Outstanding` are denominated in `debt.currency`, with
 * number formats from `moneyFmt(debt.currency)` — never from
 * `ctx.displayCurrency` (ruling R5-3). Neither `ctx.fx` nor `ctx.displayCurrency`
 * is read here: a USD debt and a VND debt are two separate obligations, and the
 * only place a current rate turns them into one number is Net Worth on the
 * Summary sheet.
 *
 * ## `Status` is derived, and needs the user's today
 *
 * OVERDUE is not stored — it is "the due date is behind us" — so the service is
 * handed `todayCalendarDateInZone(ctx.timezone, ctx.now)`: the export's own
 * instant read as a calendar day in the user's zone. Never `new Date()` inside
 * the loop, which would let two sheets of one workbook disagree about what day it
 * is, and never a UTC day, which would mark a Vietnamese user's debt overdue up
 * to a day early.
 *
 * Two queries for any number of debts (the service's own `findMany` plus one
 * `groupBy`), never a sum per row.
 */
export async function buildDebtsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const today = todayCalendarDateInZone(ctx.timezone, ctx.now)
  const rows = await getDebtsWithOutstanding(ctx.userId, today)
  const sheet = workbook.addWorksheet('Debts')

  writeHeader(sheet, [
    { header: 'Direction', width: 14 },
    { header: 'Person', width: 24 },
    { header: 'Original', width: 18 },
    { header: 'Paid', width: 18 },
    { header: 'Outstanding', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Due date', width: 14 },
    { header: 'Status', width: 14 },
    { header: 'Description', width: 32 },
    { header: 'Notes', width: 32 },
    { header: 'Created', width: 18 },
  ])

  for (const { debt, paid, outstanding, displayStatus } of rows) {
    const moneyFormat = moneyFmt(debt.currency)

    const written = sheet.addRow([
      DEBT_DIRECTION_EXPORT_LABELS[debt.direction],
      debt.person,
      moneyCell(debt.originalAmount),
      moneyCell(paid),
      // Not clamped at zero: this is the authoritative derived figure, and it
      // can only go negative if rows were written around the service — in which
      // case showing the negative is how the user finds out.
      moneyCell(outstanding),
      debt.currency,
      // The stored carrier, written straight through: a due date is already the
      // calendar day at UTC midnight (ruling R6-7). Blank when the debt has no
      // agreed date — never today's.
      debt.dueDate,
      DEBT_STATUS_LABELS[displayStatus],
      debt.description ?? '',
      debt.notes ?? '',
      // `createdAt` IS an instant, so it goes through `localDateCell`.
      localDateCell(debt.createdAt, ctx.timezone),
    ])
    // Formatted by the DEBT's currency, not the user's display currency.
    written.getCell(3).numFmt = moneyFormat
    written.getCell(4).numFmt = moneyFormat
    written.getCell(5).numFmt = moneyFormat
    written.getCell(7).numFmt = DATE_FMT
    written.getCell(11).numFmt = DATE_TIME_FMT
  }
}
