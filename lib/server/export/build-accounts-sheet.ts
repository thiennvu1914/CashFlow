import type ExcelJS from 'exceljs'
import type { Prisma } from '@prisma/client'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import { getAccountBalances } from '@/lib/server/services/balance'
import { listAllFinancialAccounts } from '@/lib/server/services/financial-account'
import {
  DATE_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  optionalMoneyCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Accounts sheet — every account the user has ever had.
 *
 * `listAllFinancialAccounts`, deliberately, not `listActiveFinancialAccounts`:
 * "export all data" includes the accounts that have been closed. An archived
 * account holds a zero balance by construction, but it is where a large part of
 * the ledger's history lives, and a workbook whose Transactions sheet references
 * an account its Accounts sheet never mentions is not a complete record. The
 * `Status` column is what distinguishes them.
 *
 * Balances come from ONE batched `getAccountBalances` call rather than a
 * per-account lookup, so the sheet costs a constant number of queries however
 * many accounts there are, and every figure on it is derived from the same read.
 *
 * The display-currency column is left blank — never zero, never a guessed
 * rate — for an account in a foreign currency when `ctx.fx` is null. The Summary
 * sheet's FX line says why.
 */
export async function buildAccountsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const accounts = await listAllFinancialAccounts(ctx.userId)
  const balances = await getAccountBalances(
    ctx.userId,
    accounts.map((account) => account.id),
  )
  const sheet = workbook.addWorksheet('Accounts')
  const displayFmt = moneyFmt(ctx.displayCurrency)

  writeHeader(sheet, [
    { header: 'Name', width: 24 },
    { header: 'Type', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Status', width: 12 },
    { header: 'Initial balance', width: 18 },
    { header: 'Current balance', width: 18 },
    { header: `Current balance (${ctx.displayCurrency})`, width: 26 },
    { header: 'Created', width: 14 },
  ])

  for (const account of accounts) {
    // `getAccountBalances` rejects the whole batch if any id fails to resolve,
    // so every requested account is present here.
    const native = balances.get(account.id) as Prisma.Decimal
    const written = sheet.addRow([
      account.name,
      account.accountType.name,
      account.currency,
      account.status,
      moneyCell(account.initialBalance),
      moneyCell(native),
      optionalMoneyCell(displayBalance(native, account.currency, ctx)),
      localDateCell(account.createdAt, ctx.timezone),
    ])
    written.getCell(5).numFmt = moneyFmt(account.currency)
    written.getCell(6).numFmt = moneyFmt(account.currency)
    written.getCell(7).numFmt = displayFmt
    written.getCell(8).numFmt = DATE_FMT
  }
}

/**
 * `native` restated in the display currency, or `null` when that cannot be done
 * honestly.
 *
 * An account already held in the display currency needs no rate at all, so it
 * is never blank during an FX outage — only a genuine conversion depends on
 * `ctx.fx`, and only that goes empty.
 */
function displayBalance(
  native: Prisma.Decimal,
  currency: ExportContext['displayCurrency'],
  ctx: ExportContext,
): Prisma.Decimal | null {
  if (currency === ctx.displayCurrency) return native
  if (!ctx.fx) return null
  return applyVndPerUsdRate(native, currency, ctx.displayCurrency, ctx.fx.rateDecimal)
}
