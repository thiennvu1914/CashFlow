import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
// Value imports, not `import type`: the workbook assertion below reloads a
// buffer with ExcelJS, reads its `ValueType` enum, and unzips the same bytes
// with JSZip (which ships inside ExcelJS and produces the .xlsx container).
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { deleteOwnedRows } from '@/lib/server/demo/owned-rows'
import { loadExportProfile, resolveExportFx } from './export-context'
import type { ExportContext } from './sheet-registry'

/**
 * Fixtures shared by the two export test suites.
 *
 * Not a `.test.ts` file, so Vitest never collects it as a suite of its own; it
 * is imported only by `filtered-export.test.ts` and `full-export.test.ts`,
 * which build the same shape of ledger and would otherwise duplicate every
 * `prisma.create` between them.
 *
 * Rows are inserted directly rather than through the services: these suites are
 * about what the workbook contains, and going through `createTransaction` would
 * add an interactive transaction, a row lock and an FX lookup per row without
 * changing a single cell.
 */

/** The `source` strings these suites can leave in the shared FX cache. */
export const EXPORT_TEST_FX_SOURCES = ['export-fake', 'export-seeded']

/** Every test user is in this zone — UTC+7, no DST, so the wall-clock
 *  arithmetic in the assertions is exact. */
export const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * A provider that always answers, so `resolveExportFx` yields a real
 * `UsableRateResult` without touching the network.
 *
 * It is consulted exactly once per export, when the context is assembled. Every
 * sheet is then handed that resolved rate, so nothing downstream reaches for a
 * provider — or a cache row — of its own, and a suite can assert an exact rate
 * without depending on what the shared `ExchangeRate` table happens to hold.
 */
export function fakeFxProvider(rate = 26000): ExchangeRateProvider {
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  return {
    getLatestRate: async () => ({
      rate,
      effectiveDate: new Date(),
      fetchedAt,
      source: 'export-fake',
    }),
    getHistoricalRate: async () => null,
  }
}

/** Stands in for a total FX outage — the only way to the "unavailable" cells. */
export const failingFxProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

export interface MakeExportContextOptions {
  /** The instant the export was requested. */
  now?: Date
  /**
   * Whether to resolve a current rate at all. `false` mirrors the filtered
   * export, which is historical end to end and reads `ctx.fx` nowhere.
   */
  withFx?: boolean
  providerOverride?: ExchangeRateProvider
}

/**
 * An `ExportContext` for a suite that wants to build a workbook — the route's
 * own two steps, `loadExportProfile` then (optionally) `resolveExportFx`, in
 * that order.
 *
 * A **test** helper on purpose. Production deliberately has no such function:
 * the route interleaves range validation between the two steps, so a malformed
 * URL costs no provider round trip and the filtered export costs none at all. A
 * shared "give me the whole context" convenience would invite a caller to fetch
 * a rate before knowing whether the request is even valid, which is exactly the
 * ordering the route exists to get right.
 */
export async function makeExportContext(
  userId: string,
  options: MakeExportContextOptions = {},
): Promise<ExportContext> {
  const { now = new Date(), withFx = true, providerOverride } = options
  const profile = await loadExportProfile(userId)
  return { ...profile, fx: withFx ? await resolveExportFx(providerOverride) : null, now }
}

export interface ExportFixture {
  userId: string
  accountTypeId: string
  vndAccountId: string
  usdAccountId: string
  expenseCategoryId: string
  incomeCategoryId: string
}

export async function createExportUser(
  baseCurrency: 'VND' | 'USD' = 'VND',
): Promise<ExportFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `export-${randomUUID()}@example.com`,
      name: 'Export Test',
      emailVerified: false,
      baseCurrency,
      timezone: TEST_TIMEZONE,
    },
  })
  const accountType = await prisma.accountType.create({
    data: { userId: user.id, name: 'Cash' },
  })
  const vndAccount = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: 0,
      currency: 'VND',
    },
  })
  const usdAccount = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Dollar savings',
      accountTypeId: accountType.id,
      initialBalance: 0,
      currency: 'USD',
    },
  })
  const expenseCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
  })
  const incomeCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  return {
    userId: user.id,
    accountTypeId: accountType.id,
    vndAccountId: vndAccount.id,
    usdAccountId: usdAccount.id,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }
}

/** The UTC start of the day containing `date` — an FX snapshot's effective day. */
export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface SeedTransaction {
  accountId: string
  categoryId?: string | null
  type?: 'INCOME' | 'EXPENSE' | 'CASH_IN' | 'CASH_OUT'
  amount: number | string
  currency?: 'VND' | 'USD'
  date: Date
  note?: string
  /** The row's OWN snapshot rate — deliberately settable per row, so a test can
   *  prove a converted column uses it rather than today's rate. */
  vndPerUsdAtEntry?: number
}

export async function seedTransaction(userId: string, row: SeedTransaction) {
  const date = row.date
  return prisma.transaction.create({
    data: {
      userId,
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      type: row.type ?? 'EXPENSE',
      amount: new Prisma.Decimal(row.amount),
      currency: row.currency ?? 'VND',
      date,
      note: row.note ?? null,
      vndPerUsdAtEntry: new Prisma.Decimal(row.vndPerUsdAtEntry ?? 25000),
      fxRateFetchedAt: date,
      fxRateEffectiveAt: utcDayStart(date),
      fxRateSource: 'export-seeded',
    },
  })
}

/** Removes every row these suites can create, FX cache rows included. */
export async function cleanupExportUsers(userIds: string[]) {
  await prisma.exchangeRate.deleteMany({ where: { source: { in: EXPORT_TEST_FX_SOURCES } } })
  // The provider fakes cache under today's USD/VND key; clear the pair outright
  // so a neighbouring suite's row cannot make an "FX unavailable" test pass a
  // rate it was never given.
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  if (userIds.length === 0) return
  try {
    // The FK-safe order this file used to spell out inline now lives in
    // `lib/server/demo/owned-rows.ts`, because the demo reset needs the very
    // same sequence and two copies would drift. Same models, same order, same
    // `where` — see that module for why each step sits where it does.
    await deleteOwnedRows(prisma, userIds)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

/** The bytes `workbook.xlsx.writeBuffer()` produces — the very thing the export
 *  route hands the browser, and the only form Excel ever sees. */
export type ExportWorkbookBuffer = Awaited<ReturnType<ExcelJS.Xlsx['writeBuffer']>>

/**
 * Every optional-text column of every sheet in the two workbooks, 1-indexed.
 *
 * These are the cells whose value is absent for some rows and a string for
 * others. Each must come back either as a non-empty string or as a genuinely
 * *empty* cell — see `expectNoEmptyStrings` for why the middle ground (an empty
 * string) is a bug Excel renders as a number.
 */
const OPTIONAL_TEXT_COLUMNS: Record<string, readonly number[]> = {
  Summary: [3],
  Transactions: [4, 13],
  Transfers: [9],
  Budgets: [4, 10],
  'Savings Goals': [9],
  Debts: [9, 10],
  'Debt Payments': [6],
  Loans: [14],
  'Loan Payments': [7],
  Reminders: [11, 12, 13],
}

/**
 * The optional-text columns of `worksheet`, or none.
 *
 * A plain name lookup, with one wrinkle: BOTH workbooks have a sheet called
 * Summary and the two are different shapes. The full export's is a
 * Metric/Value/Note table whose third column is the optional note; the filtered
 * one is a bare label/value sheet whose third column carries an account's
 * expense figure. So the Summary entry applies only to a sheet whose header row
 * reads `Metric`, which only the full export's Summary writes.
 */
function optionalTextColumns(worksheet: ExcelJS.Worksheet): readonly number[] {
  if (worksheet.name === 'Summary' && worksheet.getRow(1).getCell(1).value !== 'Metric') return []
  return OPTIONAL_TEXT_COLUMNS[worksheet.name] ?? []
}

/**
 * The `<si>` indexes in a `sharedStrings.xml` whose text is empty.
 *
 * An `<si>` may hold one `<t>` or a run of `<r><t>…</t></r>` fragments, so the
 * item's text is the concatenation of every `<t>` in it; a self-closing `<t/>`
 * and an item with no `<t>` at all both contribute nothing. Anything that ends
 * up empty is the defect this module's assertion exists to catch.
 */
function emptySharedStringIndexes(xml: string): number[] {
  const items = xml.matchAll(/<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g)
  const empty: number[] = []
  let index = 0
  for (const item of items) {
    const body = item[1] ?? ''
    let text = ''
    for (const fragment of body.matchAll(/<t\b[^>]*(?:\/>|>([\s\S]*?)<\/t>)/g)) {
      text += fragment[1] ?? ''
    }
    if (text === '') empty.push(index)
    index += 1
  }
  return empty
}

/**
 * Asserts that no cell in `workbookBuffer` is the empty string — in the file
 * Excel opens, not merely in the object model ExcelJS kept in memory.
 *
 * ExcelJS 4.4.0 stores `''` as a *shared string*: `xl/sharedStrings.xml` gains
 * an `<si><t></t></si>` and the cell becomes `<c t="s"><v>N</v></c>`. Excel
 * treats an empty shared-string item as missing and renders the raw index `N`
 * as the cell's text, so every absent note in a workbook shows the same stray
 * number (a literal "4", in the report that found this). A `null` writes no
 * `<c>` element at all, which is the blank the reader expects.
 *
 * The check therefore has to happen on the serialized bytes: ExcelJS reloads
 * `''` faithfully as `''`, so an in-memory `expect(cell.value).toBe('')` passes
 * on a workbook Excel renders wrongly. Two halves:
 *
 * 1. the shared-string table carries no empty item, whatever wrote it;
 * 2. reloaded, no cell of any sheet is `''`, and every column listed in
 *    `OPTIONAL_TEXT_COLUMNS` holds either a non-empty string or a truly empty
 *    cell (`ValueType.Null`) — never a `0`, a `''` or an `undefined`.
 */
export async function expectNoEmptyStrings(workbookBuffer: ExportWorkbookBuffer): Promise<void> {
  const zip = await JSZip.loadAsync(workbookBuffer)
  const sharedStrings = zip.file('xl/sharedStrings.xml')
  // Absent only for a workbook with no strings at all, which neither export can
  // produce (every sheet writes a header row).
  if (sharedStrings === null) throw new Error('the workbook has no xl/sharedStrings.xml')
  const xml = await sharedStrings.async('string')
  expect(
    emptySharedStringIndexes(xml),
    'xl/sharedStrings.xml has empty <si> items; Excel renders their index as the cell text',
  ).toEqual([])

  const reloaded = new ExcelJS.Workbook()
  await reloaded.xlsx.load(workbookBuffer)
  for (const worksheet of reloaded.worksheets) {
    const optional = optionalTextColumns(worksheet)
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        const where = `${worksheet.name}!${cell.address}`
        expect(cell.value, where).not.toBe('')
        if (rowNumber === 1 || !optional.includes(column)) return
        if (typeof cell.value === 'string') {
          expect(cell.value, where).not.toBe('')
          return
        }
        expect(cell.value, where).toBeNull()
        expect(cell.type, where).toBe(ExcelJS.ValueType.Null)
      })
    })
  }
}
