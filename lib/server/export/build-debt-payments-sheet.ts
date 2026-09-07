import type ExcelJS from 'exceljs'
import { prisma } from '@/lib/prisma'
import { DEBT_DIRECTION_EXPORT_LABELS } from './build-debts-sheet'
import { DATE_FMT, moneyCell, moneyFmt, writeHeader } from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Debt Payments sheet — every repayment ever recorded, against every debt
 * (spec §4.9, §12).
 *
 * ## Why a sheet of its own
 *
 * The Debts sheet carries one row per debt with a single `Paid` total. That total
 * is *made of* these rows, and a workbook that held only the total would have
 * dropped the history it was derived from: when each instalment landed, and what
 * the user wrote next to it. One row per payment is also the shape a reader can
 * pivot — payments per person, per month — which is the whole reason to export a
 * spreadsheet rather than a screenshot.
 *
 * ## History is never omitted
 *
 * The read is scoped by `userId` alone: payments against a WRITTEN_OFF debt are
 * here too, because they really were paid. Nothing in this app deletes a payment,
 * so this sheet is the complete history by construction.
 *
 * ## Each payment in its PARENT's currency
 *
 * A `DebtPayment` has no currency column — it inherits the debt's, there being no
 * cross-currency debt payments in the MVP — so `Currency` and the `Amount`
 * format both come from the included `debt.currency`. Never from
 * `ctx.displayCurrency`, and nothing here is converted: `ctx.fx` is not read at
 * all.
 *
 * ## One query, and the parent comes with it
 *
 * The debt's person, direction and currency arrive through the `include` rather
 * than from a lookup per row — a full export of a user with a thousand payments
 * must cost one query, not a thousand and one. Ordered oldest first, with
 * `createdAt` and `id` as tie-breaks: `date` is a calendar-date carrier so any
 * number of payments can share a day, and without the tie-breaks the same
 * history could come out in a different order on the next export.
 */
export async function buildDebtPaymentsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const payments = await prisma.debtPayment.findMany({
    where: { userId: ctx.userId },
    include: { debt: { select: { person: true, direction: true, currency: true } } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const sheet = workbook.addWorksheet('Debt Payments')

  writeHeader(sheet, [
    { header: 'Date', width: 14 },
    { header: 'Debt', width: 24 },
    { header: 'Direction', width: 14 },
    { header: 'Amount', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Note', width: 40 },
  ])

  for (const payment of payments) {
    const written = sheet.addRow([
      // The stored carrier, written straight through: a payment date is already
      // the calendar day at UTC midnight (ruling R6-7), and re-projecting it
      // through `ctx.timezone` would move it a day for most of the world.
      payment.date,
      payment.debt.person,
      DEBT_DIRECTION_EXPORT_LABELS[payment.debt.direction],
      moneyCell(payment.amount),
      payment.debt.currency,
      payment.note ?? '',
    ])
    written.getCell(1).numFmt = DATE_FMT
    // The PARENT debt's currency decides the format — a payment has none of its
    // own, and the user's display currency has no say.
    written.getCell(4).numFmt = moneyFmt(payment.debt.currency)
  }
}
