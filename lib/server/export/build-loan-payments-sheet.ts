import type ExcelJS from 'exceljs'
import { prisma } from '@/lib/prisma'
import { DATE_FMT, moneyCell, moneyFmt, writeHeader } from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Loan Payments sheet — every instalment ever recorded, against every loan
 * (spec §4.10, §12).
 *
 * ## Why a sheet of its own, and why three money columns
 *
 * The Loans sheet carries one row per loan with `Principal paid` and `Interest
 * paid` totals. Those totals are *made of* these rows, and only this sheet says
 * how a single instalment was split — which is the fact a borrower checks
 * against their statement. `Total`, `Principal` and `Interest` are written as
 * they were recorded (`Total = Principal + Interest`, enforced three times over
 * by Zod, by the service under the row lock, and by a database CHECK), so an
 * interest-only instalment reads as a zero principal rather than as a missing
 * row.
 *
 * ## History is never omitted
 *
 * The read is scoped by `userId` alone: instalments against a CLOSED loan are
 * here too, because they really were paid. Nothing in this app deletes a
 * payment, so this sheet is the complete history by construction.
 *
 * ## Each instalment in its PARENT's currency
 *
 * A `LoanPayment` has no currency column — it inherits the loan's, there being no
 * cross-currency loan payments in the MVP — so `Currency` and all three money
 * formats come from the included `loan.currency`. Never from
 * `ctx.displayCurrency`, and nothing here is converted: `ctx.fx` is not read at
 * all.
 *
 * ## One query, and the parent comes with it
 *
 * The lender and currency arrive through the `include` rather than from a lookup
 * per row. Ordered oldest first, with `createdAt` and `id` as tie-breaks:
 * `paymentDate` is a calendar-date carrier so several instalments can share a
 * day, and without the tie-breaks the same history could come out in a different
 * order on the next export.
 */
export async function buildLoanPaymentsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const payments = await prisma.loanPayment.findMany({
    where: { userId: ctx.userId },
    include: { loan: { select: { lender: true, currency: true } } },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const sheet = workbook.addWorksheet('Loan Payments')

  writeHeader(sheet, [
    { header: 'Date', width: 14 },
    { header: 'Loan', width: 24 },
    { header: 'Total', width: 18 },
    { header: 'Principal', width: 18 },
    { header: 'Interest', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Note', width: 40 },
  ])

  for (const payment of payments) {
    // The PARENT loan's currency decides every format — an instalment has none
    // of its own, and the user's display currency has no say.
    const moneyFormat = moneyFmt(payment.loan.currency)

    const written = sheet.addRow([
      // The stored carrier, written straight through: a payment date is already
      // the calendar day at UTC midnight (ruling R6-7).
      payment.paymentDate,
      payment.loan.lender,
      moneyCell(payment.totalAmount),
      moneyCell(payment.principalAmount),
      moneyCell(payment.interestAmount),
      payment.loan.currency,
      payment.note ?? '',
    ])
    written.getCell(1).numFmt = DATE_FMT
    written.getCell(3).numFmt = moneyFormat
    written.getCell(4).numFmt = moneyFormat
    written.getCell(5).numFmt = moneyFormat
  }
}
