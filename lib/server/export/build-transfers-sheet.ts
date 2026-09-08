import type ExcelJS from 'exceljs'
import { listTransfersForExport } from '@/lib/server/services/transfer'
import {
  DATE_TIME_FMT,
  RATE_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  textCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Transfers sheet — internal movements between the user's own accounts
 * (spec §4.5).
 *
 * A transfer is its own entity, never a pair of transactions: it has no
 * category, never counts as income or expense, and carries no FX snapshot. So
 * there is no display-currency column here and nothing on this sheet is
 * converted. Both legs are written in their own currencies, side by side, with
 * the rate that was actually applied between them — the only rate a transfer
 * knows. `Rate used` is blank for a same-currency transfer, where money is
 * conserved by construction and there was no conversion to record.
 */
export async function buildTransfersSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const rows = await listTransfersForExport(ctx.userId)
  const sheet = workbook.addWorksheet('Transfers')

  writeHeader(sheet, [
    { header: 'Date', width: 18 },
    { header: 'From account', width: 22 },
    { header: 'To account', width: 22 },
    { header: 'From amount', width: 16 },
    { header: 'From currency', width: 14 },
    { header: 'To amount', width: 16 },
    { header: 'To currency', width: 14 },
    { header: 'Rate used', width: 18 },
    { header: 'Note', width: 40 },
  ])

  for (const row of rows) {
    const written = sheet.addRow([
      localDateCell(row.date, ctx.timezone),
      row.fromAccount.name,
      row.toAccount.name,
      moneyCell(row.fromAmount),
      row.fromAccount.currency,
      moneyCell(row.toAmount),
      row.toAccount.currency,
      // Blank, not zero and not 1: a same-currency transfer applied no rate at
      // all, and writing one would invent a fact the row does not hold.
      row.exchangeRateUsed === null ? null : moneyCell(row.exchangeRateUsed),
      textCell(row.note),
    ])
    written.getCell(1).numFmt = DATE_TIME_FMT
    written.getCell(4).numFmt = moneyFmt(row.fromAccount.currency)
    written.getCell(6).numFmt = moneyFmt(row.toAccount.currency)
    // A cross-currency rate can be far below 1 (VND per USD inverted), so it
    // gets the full six fractional digits rather than a money format.
    written.getCell(8).numFmt = RATE_FMT
  }
}
