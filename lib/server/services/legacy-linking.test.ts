import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import { resetFxMemoForTests } from '@/lib/currency/fx-service'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { LOAN_INTEREST_CATEGORY_NAME } from '@/lib/server/defaults'
import { getAccountBalance } from '@/lib/server/services/balance'
import type { CreateDebtInput, LinkDebtToAccountInput } from '@/lib/validation/debt'
import type { CreateLoanInput, LinkLoanToAccountInput } from '@/lib/validation/loan'
import { ArchivedAccountError } from './account-lock'
import { LinkedAccountCurrencyMismatchError } from './linked-transaction'
import {
  createDebt as createDebtIn,
  linkDebtToAccount as linkDebtToAccountIn,
  listDebts,
  recordDebtPayment as recordDebtPaymentIn,
  writeOffDebt,
  DebtAlreadyLinkedError,
  type DebtLinkContext,
} from './debt'
import {
  closeLoan,
  createLoan as createLoanIn,
  linkLoanToAccount as linkLoanToAccountIn,
  listLoans,
  recordLoanPayment as recordLoanPaymentIn,
  LoanAlreadyLinkedError,
  type LoanLinkContext,
} from './loan'

/**
 * "Record in an account" — legacy linking (money-source linking spec
 * 2026-10-12 §2 Q3, §4, §6.4) — against the real database.
 *
 * A debt or a loan recorded before linking existed (or with "don't record in an
 * account") has no transaction behind it, so the account the money really moved
 * through shows a balance that disagrees with the agreement. Linking it after
 * the fact creates exactly the transactions recording it with an account would
 * have created — the opening (debt) or disbursement (loan) on the day the user
 * picks, and, when asked, one per existing payment that has none yet (two for a
 * loan instalment with interest), each on its own date — in one database
 * transaction, with one FX snapshot fetched before it opens.
 *
 * Its own file rather than two more blocks in `debt.test.ts` and
 * `loan.test.ts`, which are already the two largest suites in the repo; the
 * fixture (four accounts, no categories, an injected FX provider) is the one
 * both of their linking blocks use.
 *
 * Every FX lookup goes through an injected fake provider whose snapshot values
 * are asserted exactly, and `fetch` is a throwing spy, so nothing here can
 * reach the network. The USD/VND `ExchangeRate` cache rows are global, so
 * `beforeEach` and `afterEach` delete them and reset the in-process FX memo.
 * "No FX lookup happened" is proved with `failingProvider` over that empty
 * cache: a lookup there could only end in `FxUnavailableError`.
 */

/** UTC+7, no DST — so no assertion below depends on a DST date. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'
const DEBT_CONTEXT: DebtLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }
const LOAN_CONTEXT: LoanLinkContext = { timezone: TEST_TIMEZONE, locale: 'vi' }
const FX_SOURCE = 'legacy-link-fake'

const BASE_DEBT = {
  direction: 'RECEIVABLE' as const,
  person: 'Nguyen An',
  originalAmount: 1_000_000,
  currency: 'VND' as const,
}

const BASE_LOAN = {
  lender: 'Vietcombank',
  principal: 1_000_000,
  currency: 'VND' as const,
  interestRate: 8.5,
  startDate: '2026-01-01',
  termMonths: 12,
  paymentFrequency: 'MONTHLY' as const,
  scheduledPaymentAmount: 90_000,
  nextDueDate: '2026-02-01',
}

const createdUserIds: string[] = []
let fetchSpy: MockInstance

function fakeProvider(rate = 25000) {
  // In the past, so a service that stamped "now" instead of the provider's own
  // fetch instant could not pass an equality check.
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  const effectiveDate = new Date()
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => ({ rate, effectiveDate, fetchedAt, source: FX_SOURCE }),
    getHistoricalRate: async () => null,
  }
  return { provider, fetchedAt, effectiveDate }
}

const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

async function clearFxCache() {
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  // The in-process memo would otherwise outlive the rows just deleted.
  resetFxMemoForTests()
}

/** The writes under test and their setup, with the test context applied. */
function createDebt(userId: string, input: CreateDebtInput, provider?: ExchangeRateProvider) {
  return createDebtIn(userId, input, DEBT_CONTEXT, provider)
}

function recordDebtPayment(
  userId: string,
  debtId: string,
  input: { amount: number; date: string; note?: string; accountId?: string },
  provider?: ExchangeRateProvider,
) {
  return recordDebtPaymentIn(userId, debtId, input, DEBT_CONTEXT, provider)
}

function linkDebtToAccount(
  userId: string,
  debtId: string,
  input: LinkDebtToAccountInput,
  provider: ExchangeRateProvider,
  context: DebtLinkContext = DEBT_CONTEXT,
) {
  return linkDebtToAccountIn(userId, debtId, input, context, provider)
}

function createLoan(userId: string, input: CreateLoanInput, provider?: ExchangeRateProvider) {
  return createLoanIn(userId, input, LOAN_CONTEXT, provider)
}

function recordLoanPayment(
  userId: string,
  loanId: string,
  input: {
    totalAmount: number
    principalAmount: number
    interestAmount: number
    paymentDate: string
    note?: string
    accountId?: string
  },
  provider?: ExchangeRateProvider,
) {
  return recordLoanPaymentIn(userId, loanId, input, LOAN_CONTEXT, provider)
}

function linkLoanToAccount(
  userId: string,
  loanId: string,
  input: LinkLoanToAccountInput,
  provider: ExchangeRateProvider,
  context: LoanLinkContext = LOAN_CONTEXT,
) {
  return linkLoanToAccountIn(userId, loanId, input, context, provider)
}

/**
 * A user with three active accounts — two in VND, one in USD — and an archived
 * VND one, and no categories at all (so a first interest leg has to create
 * "Loan Interest & Fees"). Each funded account starts at a distinct round
 * figure, so every balance assertion below is a delta anyone can check by eye.
 */
async function setup() {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `legacy-link-${randomUUID()}@example.com`,
      name: 'Legacy Link Test',
      emailVerified: false,
      timezone: TEST_TIMEZONE,
    },
  })
  createdUserIds.push(user.id)
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = (name: string, currency: 'VND' | 'USD', initialBalance: string) =>
    prisma.financialAccount.create({
      data: {
        userId: user.id,
        name,
        accountTypeId: accountType.id,
        initialBalance: new Prisma.Decimal(initialBalance),
        currency,
      },
    })
  const wallet = await account('Wallet', 'VND', '5000000')
  const bank = await account('Bank', 'VND', '2000000')
  const dollars = await account('Dollars', 'USD', '1000')
  const archived = await account('Old', 'VND', '0')
  await prisma.financialAccount.update({
    where: { userId_id: { userId: user.id, id: archived.id } },
    data: { status: 'ARCHIVED' },
  })
  return {
    userId: user.id,
    walletId: wallet.id,
    bankId: bank.id,
    dollarsId: dollars.id,
    archivedId: archived.id,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function balanceOf(s: Setup, accountId: string): Promise<string> {
  return (await getAccountBalance(s.userId, accountId)).toString()
}

async function transactionCount(s: Setup): Promise<number> {
  return prisma.transaction.count({ where: { userId: s.userId } })
}

async function transactionById(s: Setup, id: string | null) {
  if (id === null) throw new Error('expected a linked transaction')
  return prisma.transaction.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
}

function interestCategories(s: Setup) {
  return prisma.category.findMany({
    where: { userId: s.userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE' },
  })
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

async function expectPrismaCode(promise: Promise<unknown>, code: string) {
  const caught = await captureRejection(promise)
  expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(code)
}

/**
 * Makes the next interactive transaction fail at one write *after* the linked
 * transactions have been written inside it — the only way to watch the
 * rollback itself, since every refusal the service makes on its own happens
 * before its first write. `prisma.$transaction` is wrapped so the callback
 * receives a transaction client whose `model.method` throws; everything else
 * is the real client on the real transaction (the helper `loan.test.ts` uses).
 */
function failInsideTransaction(model: 'debt' | 'loan', method: 'update') {
  const original = prisma.$transaction.bind(prisma) as (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>
  const failure = new Error(`injected ${model}.${method} failure`)
  vi.spyOn(prisma, '$transaction').mockImplementation(((
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) =>
    original((tx) =>
      callback(
        new Proxy(tx, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property !== model) return value
            return new Proxy(value as object, {
              get(delegate, name) {
                if (name === method) {
                  return async () => {
                    throw failure
                  }
                }
                return Reflect.get(delegate, name)
              },
            })
          },
        }),
      ),
    )) as never)
  return failure
}

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in test')
  })
  // The FX fallback path warns by design; silenced to keep the output pristine.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Today's USD/VND row is shared by every suite, so a rate another file left
  // behind would otherwise be served instead of this file's fake provider.
  await clearFxCache()
})

afterEach(async () => {
  const fetchCalls = fetchSpy.mock.calls.length
  vi.restoreAllMocks()
  const userIds = createdUserIds.splice(0)
  try {
    await clearFxCache()
    if (userIds.length > 0) {
      // Payments and agreements first: they reference the transactions.
      await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
  expect(fetchCalls).toBe(0)
})

describe('linkDebtToAccount', () => {
  async function debtById(s: Setup, id: string) {
    return prisma.debt.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  async function paymentsOf(s: Setup, debtId: string) {
    return prisma.debtPayment.findMany({
      where: { userId: s.userId, debtId },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    })
  }

  it('records the opening of a debt created without an account on the chosen day, leaving its payments alone when asked to', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, { amount: 200_000, date: '2026-03-05' })
    const { provider, fetchedAt, effectiveDate } = fakeProvider()

    const linked = await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: false },
      provider,
    )

    expect(linked.openingTransactionId).not.toBeNull()
    // What the payment picker pre-selects from now on travels with the row.
    expect(linked.openingTransaction).toMatchObject({ accountId: s.walletId })
    const opening = await transactionById(s, linked.openingTransactionId)
    expect(opening).toMatchObject({
      accountId: s.walletId,
      // RECEIVABLE: the user lent the money, so it left the account.
      type: 'CASH_OUT',
      currency: 'VND',
      categoryId: null,
      // No debt notes: the label, rendered once in the user's locale.
      note: 'Cho mượn – Nguyen An',
      fxRateSource: FX_SOURCE,
    })
    expect(opening.amount.toString()).toBe('1000000')
    // 12:00 on 2026-03-01 in Asia/Ho_Chi_Minh (UTC+7).
    expect(opening.date.toISOString()).toBe('2026-03-01T05:00:00.000Z')
    expect(opening.vndPerUsdAtEntry.toString()).toBe('25000')
    expect(opening.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
    expect(opening.fxRateEffectiveAt.toISOString()).toBe(
      new Date(
        Date.UTC(
          effectiveDate.getUTCFullYear(),
          effectiveDate.getUTCMonth(),
          effectiveDate.getUTCDate(),
        ),
      ).toISOString(),
    )

    // Only the opening moved: the payment stays tracking-only.
    expect(await transactionCount(s)).toBe(1)
    expect(await balanceOf(s, s.walletId)).toBe('4000000')
    const [payment] = await paymentsOf(s, debt.id)
    expect(payment.transactionId).toBeNull()
  })

  it('records every existing payment on its own date, with its own note or the label', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, {
      amount: 200_000,
      date: '2026-03-05',
      note: 'Đợt một',
    })
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-10' })
    const { provider, fetchedAt } = fakeProvider()

    const linked = await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
      provider,
    )

    const [first, second] = await paymentsOf(s, debt.id)
    const firstTx = await transactionById(s, first.transactionId)
    const secondTx = await transactionById(s, second.transactionId)
    // RECEIVABLE repayments come back in.
    expect(firstTx).toMatchObject({ accountId: s.walletId, type: 'CASH_IN', note: 'Đợt một' })
    expect(firstTx.amount.toString()).toBe('200000')
    expect(firstTx.date.toISOString()).toBe('2026-03-05T05:00:00.000Z')
    expect(secondTx).toMatchObject({
      accountId: s.walletId,
      type: 'CASH_IN',
      note: 'Thu nợ – Nguyen An',
    })
    expect(secondTx.amount.toString()).toBe('100000')
    expect(secondTx.date.toISOString()).toBe('2026-03-10T05:00:00.000Z')
    // One rate for the whole operation, fetched once before the transaction.
    for (const row of [firstTx, secondTx, await transactionById(s, linked.openingTransactionId)]) {
      expect(row.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
      expect(row.fxRateSource).toBe(FX_SOURCE)
    }
    // The returned row carries each payment's account, for the edit form.
    expect(linked.payments.map((p) => p.transaction?.accountId)).toEqual([s.walletId, s.walletId])

    // 5,000,000 − 1,000,000 lent + 300,000 repaid.
    expect(await transactionCount(s)).toBe(3)
    expect(await balanceOf(s, s.walletId)).toBe('4300000')
  })

  it('records a PAYABLE as a CASH_IN with the debt notes, and its repayments as CASH_OUT, in the English labels for an English user', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, {
      direction: 'PAYABLE',
      person: 'Binh',
      originalAmount: 300_000,
      currency: 'VND',
      notes: 'For the rent',
    })
    await recordDebtPayment(s.userId, debt.id, { amount: 50_000, date: '2026-03-20' })

    const linked = await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.bankId, openedOn: '2026-03-15', includePayments: true },
      fakeProvider().provider,
      { timezone: TEST_TIMEZONE, locale: 'en' },
    )

    const opening = await transactionById(s, linked.openingTransactionId)
    expect(opening).toMatchObject({ type: 'CASH_IN', note: 'For the rent' })
    const [payment] = await paymentsOf(s, debt.id)
    expect(await transactionById(s, payment.transactionId)).toMatchObject({
      type: 'CASH_OUT',
      note: 'Repaid to Binh',
    })
    // 2,000,000 + 300,000 borrowed − 50,000 repaid.
    expect(await balanceOf(s, s.bankId)).toBe('2250000')
  })

  it('skips a payment that is already recorded in an account and leaves its transaction untouched', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    const { provider } = fakeProvider()
    const already = await recordDebtPayment(
      s.userId,
      debt.id,
      { amount: 150_000, date: '2026-03-04', accountId: s.bankId },
      provider,
    )
    const before = await transactionById(s, already.transactionId)
    await recordDebtPayment(s.userId, debt.id, { amount: 50_000, date: '2026-03-06' })

    await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
      provider,
    )

    const [first, second] = await paymentsOf(s, debt.id)
    expect(first.transactionId).toBe(already.transactionId)
    expect(await transactionById(s, first.transactionId)).toEqual(before)
    expect(await transactionById(s, second.transactionId)).toMatchObject({
      accountId: s.walletId,
      type: 'CASH_IN',
    })
    // The bank keeps its 150,000; the wallet gets the opening and the 50,000.
    expect(await transactionCount(s)).toBe(3)
    expect(await balanceOf(s, s.bankId)).toBe('2150000')
    expect(await balanceOf(s, s.walletId)).toBe('4050000')
  })

  it('dates an opening made today at the current instant, so the balance moves at once', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    const before = Date.now()

    const linked = await linkDebtToAccount(
      s.userId,
      debt.id,
      {
        accountId: s.walletId,
        openedOn: todayCalendarDateInZone(TEST_TIMEZONE),
        includePayments: true,
      },
      fakeProvider().provider,
    )

    const opening = await transactionById(s, linked.openingTransactionId)
    expect(opening.date.getTime()).toBeGreaterThanOrEqual(before)
    expect(opening.date.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await balanceOf(s, s.walletId)).toBe('4000000')
  })

  it('links a written-off debt too — the money did move — and keeps it written off', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, { amount: 400_000, date: '2026-03-05' })
    await writeOffDebt(s.userId, debt.id)

    const linked = await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
      fakeProvider().provider,
    )

    expect(linked.status).toBe('WRITTEN_OFF')
    expect(await transactionCount(s)).toBe(2)
    expect(await balanceOf(s, s.walletId)).toBe('4400000')
  })

  it('refuses a debt whose opening is already recorded, before any rate lookup, and writes nothing', async () => {
    const s = await setup()
    const debt = await createDebt(
      s.userId,
      { ...BASE_DEBT, accountId: s.bankId, movedOn: '2026-03-01' },
      fakeProvider().provider,
    )
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-05' })
    await clearFxCache()

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
        failingProvider,
      ),
    ).rejects.toThrow(DebtAlreadyLinkedError)

    expect(await transactionCount(s)).toBe(1)
    expect((await paymentsOf(s, debt.id))[0].transactionId).toBeNull()
    expect((await debtById(s, debt.id)).openingTransactionId).toBe(debt.openingTransactionId)
  })

  it('lets exactly one of two concurrent links through; the other is refused under the lock', async () => {
    const s = await setup()
    const { provider } = fakeProvider()
    for (const run of [1, 2, 3]) {
      const debt = await createDebt(s.userId, { ...BASE_DEBT, person: `Race ${run}` })

      const results = await Promise.allSettled([
        linkDebtToAccount(
          s.userId,
          debt.id,
          { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
          provider,
        ),
        linkDebtToAccount(
          s.userId,
          debt.id,
          { accountId: s.bankId, openedOn: '2026-03-01', includePayments: true },
          provider,
        ),
      ])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((r) => r.status === 'rejected')
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(DebtAlreadyLinkedError)
      expect(
        await prisma.transaction.count({
          where: { userId: s.userId, note: { contains: `Race ${run}` } },
        }),
      ).toBe(1)
    }
  }, 30_000)

  it('refuses an account in another currency and writes nothing', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-05' })

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.dollarsId, openedOn: '2026-03-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toThrow(LinkedAccountCurrencyMismatchError)

    expect(await transactionCount(s)).toBe(0)
    expect((await debtById(s, debt.id)).openingTransactionId).toBeNull()
    expect((await paymentsOf(s, debt.id))[0].transactionId).toBeNull()
  })

  it('refuses an archived account and writes nothing', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.archivedId, openedOn: '2026-03-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toThrow(ArchivedAccountError)

    expect(await transactionCount(s)).toBe(0)
    expect((await debtById(s, debt.id)).openingTransactionId).toBeNull()
  })

  it('writes nothing when no usable rate exists', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
        failingProvider,
      ),
    ).rejects.toThrow(FxUnavailableError)

    expect(await transactionCount(s)).toBe(0)
    expect((await debtById(s, debt.id)).openingTransactionId).toBeNull()
  })

  it("refuses another user's debt and another user's account with P2025, writing nothing for either user", async () => {
    const s = await setup()
    const other = await setup()
    const mine = await createDebt(s.userId, BASE_DEBT)
    const theirs = await createDebt(other.userId, BASE_DEBT)
    const { provider } = fakeProvider()

    await expectPrismaCode(
      linkDebtToAccount(
        s.userId,
        theirs.id,
        { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
        provider,
      ),
      'P2025',
    )
    await expectPrismaCode(
      linkDebtToAccount(
        s.userId,
        mine.id,
        { accountId: other.walletId, openedOn: '2026-03-01', includePayments: true },
        provider,
      ),
      'P2025',
    )

    expect(await transactionCount(s)).toBe(0)
    expect(await transactionCount(other)).toBe(0)
    expect((await debtById(other, theirs.id)).openingTransactionId).toBeNull()
    expect((await debtById(s, mine.id)).openingTransactionId).toBeNull()
  })

  it('rolls everything back when a write after the linked transactions fails', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-05' })
    const failure = failInsideTransaction('debt', 'update')

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toBe(failure)

    vi.restoreAllMocks()
    expect(await transactionCount(s)).toBe(0)
    expect((await debtById(s, debt.id)).openingTransactionId).toBeNull()
    expect((await paymentsOf(s, debt.id))[0].transactionId).toBeNull()
    expect(await balanceOf(s, s.walletId)).toBe('5000000')
  })

  describe('lock order', () => {
    const LOCK_WAIT_MS = 300
    const heldLocks: { release: () => Promise<void> }[] = []

    afterEach(async () => {
      // Runs before the suite's cleanup; releasing twice is harmless.
      for (const lock of heldLocks.splice(0)) await lock.release()
    })

    function hasSettledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
      const settled = promise.then(
        () => true,
        () => true,
      )
      const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
      return Promise.race([settled, timer])
    }

    async function holdAccountLock(userId: string, accountId: string) {
      let openGate: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      let signalAcquired: () => void = () => {}
      const acquired = new Promise<void>((resolve) => {
        signalAcquired = resolve
      })
      const held = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "FinancialAccount" WHERE "userId"=${userId} AND "id"=${accountId} FOR UPDATE`
          signalAcquired()
          await gate
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      await Promise.race([acquired, held])
      const lock = {
        release: async () => {
          openGate()
          await held
        },
      }
      heldLocks.push(lock)
      return lock
    }

    it('waits on the account before it takes the debt lock, then records the payment that landed meanwhile', async () => {
      const s = await setup()
      const debt = await createDebt(s.userId, BASE_DEBT)
      const { provider } = fakeProvider()
      // Warms the FX cache, so the link below waits on nothing but the row lock.
      await createDebt(
        s.userId,
        { ...BASE_DEBT, person: 'Warm-up', accountId: s.bankId, movedOn: '2026-03-01' },
        provider,
      )
      const lock = await holdAccountLock(s.userId, s.walletId)

      const pending = linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
        provider,
      )
      expect(await hasSettledWithin(pending, LOCK_WAIT_MS)).toBe(false)

      // Queued on the account, the link holds no debt lock yet: a payment with
      // no account — which takes only the debt lock — goes straight through.
      const payment = recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-05' })
      expect(await hasSettledWithin(payment, LOCK_WAIT_MS)).toBe(true)
      await payment

      await lock.release()
      const linked = await pending
      // It read the payments under the debt lock, after that one committed.
      expect(linked.payments.map((p) => p.transaction?.accountId)).toEqual([s.walletId])
      expect(await balanceOf(s, s.walletId)).toBe('4100000')
    }, 30_000)
  })

  it('is what the Debts page reads afterwards: the debt and its payments carry the account', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT)
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: '2026-03-05' })

    await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
      fakeProvider().provider,
    )

    const [row] = await listDebts(s.userId)
    expect(row.openingTransaction?.accountId).toBe(s.walletId)
    expect(row.payments[0].transaction?.accountId).toBe(s.walletId)
  })
})

describe('linkLoanToAccount', () => {
  async function loanById(s: Setup, id: string) {
    return prisma.loan.findUniqueOrThrow({ where: { userId_id: { userId: s.userId, id } } })
  }

  async function paymentsOf(s: Setup, loanId: string) {
    return prisma.loanPayment.findMany({
      where: { userId: s.userId, loanId },
      orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
    })
  }

  it('records the disbursement of a loan created without an account on the chosen day, leaving its instalments alone when asked to', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
    })
    const { provider, fetchedAt } = fakeProvider()

    const linked = await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: false },
      provider,
    )

    const disbursement = await transactionById(s, linked.disbursementTransactionId)
    expect(disbursement).toMatchObject({
      accountId: s.walletId,
      type: 'CASH_IN',
      currency: 'VND',
      categoryId: null,
      note: 'Vay – Vietcombank',
      fxRateSource: FX_SOURCE,
    })
    expect(disbursement.amount.toString()).toBe('1000000')
    expect(disbursement.date.toISOString()).toBe('2026-01-01T05:00:00.000Z')
    expect(disbursement.vndPerUsdAtEntry.toString()).toBe('25000')
    expect(disbursement.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())

    expect(await transactionCount(s)).toBe(1)
    expect(await balanceOf(s, s.walletId)).toBe('6000000')
    const [payment] = await paymentsOf(s, loan.id)
    expect(payment).toMatchObject({ principalTransactionId: null, interestTransactionId: null })
    // Nothing was filed under interest, so the category was not needed.
    expect(await interestCategories(s)).toHaveLength(0)
  })

  it('records every instalment on its own date — principal as CASH_OUT, interest as an EXPENSE in "Loan Interest & Fees", a zero part as nothing — and leaves the schedule alone', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, { ...BASE_LOAN, notes: 'Mua xe' })
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
      note: 'Kỳ 1',
    })
    // Interest only, then principal only: each writes one transaction.
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 10_000,
      principalAmount: 0,
      interestAmount: 10_000,
      paymentDate: '2026-03-01',
    })
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 80_000,
      principalAmount: 80_000,
      interestAmount: 0,
      paymentDate: '2026-04-01',
    })
    const scheduleBefore = (await loanById(s, loan.id)).nextDueDate
    const { provider, fetchedAt } = fakeProvider()

    const linked = await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      provider,
    )

    // The loan's notes are the disbursement's note.
    expect(await transactionById(s, linked.disbursementTransactionId)).toMatchObject({
      note: 'Mua xe',
    })
    const [first, interestOnly, principalOnly] = await paymentsOf(s, loan.id)
    const [category] = await interestCategories(s)
    expect(await interestCategories(s)).toHaveLength(1)

    const firstPrincipal = await transactionById(s, first.principalTransactionId)
    const firstInterest = await transactionById(s, first.interestTransactionId)
    expect(firstPrincipal).toMatchObject({ type: 'CASH_OUT', categoryId: null, note: 'Kỳ 1' })
    expect(firstPrincipal.amount.toString()).toBe('80000')
    expect(firstPrincipal.date.toISOString()).toBe('2026-02-01T05:00:00.000Z')
    expect(firstInterest).toMatchObject({
      type: 'EXPENSE',
      categoryId: category.id,
      note: 'Kỳ 1',
    })
    expect(firstInterest.amount.toString()).toBe('10000')
    expect(firstInterest.date.toISOString()).toBe('2026-02-01T05:00:00.000Z')

    expect(interestOnly.principalTransactionId).toBeNull()
    expect(await transactionById(s, interestOnly.interestTransactionId)).toMatchObject({
      type: 'EXPENSE',
      note: 'Lãi vay – Vietcombank',
      date: new Date('2026-03-01T05:00:00.000Z'),
    })
    expect(principalOnly.interestTransactionId).toBeNull()
    expect(await transactionById(s, principalOnly.principalTransactionId)).toMatchObject({
      type: 'CASH_OUT',
      note: 'Trả gốc – Vietcombank',
      date: new Date('2026-04-01T05:00:00.000Z'),
    })

    const all = await prisma.transaction.findMany({ where: { userId: s.userId } })
    expect(all).toHaveLength(5)
    for (const row of all) {
      expect(row.accountId).toBe(s.walletId)
      expect(row.fxRateFetchedAt.toISOString()).toBe(fetchedAt.toISOString())
    }
    // 5,000,000 + 1,000,000 received − 90,000 − 10,000 − 80,000 paid.
    expect(await balanceOf(s, s.walletId)).toBe('5820000')
    // Linking records money that already moved; it pays no instalment.
    expect((await loanById(s, loan.id)).nextDueDate).toEqual(scheduleBefore)
  })

  it('skips an instalment that is already recorded in an account and reuses the interest category', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    const { provider } = fakeProvider()
    const { payment: already } = await recordLoanPayment(
      s.userId,
      loan.id,
      {
        totalAmount: 90_000,
        principalAmount: 80_000,
        interestAmount: 10_000,
        paymentDate: '2026-02-01',
        accountId: s.bankId,
      },
      provider,
    )
    const before = await prisma.transaction.findMany({
      where: { userId: s.userId },
      orderBy: { id: 'asc' },
    })
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-03-01',
    })

    await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      provider,
    )

    const [first, second] = await paymentsOf(s, loan.id)
    expect(first).toMatchObject({
      principalTransactionId: already.principalTransactionId,
      interestTransactionId: already.interestTransactionId,
    })
    expect(
      await prisma.transaction.findMany({
        where: { id: { in: before.map((row) => row.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before)
    expect(await transactionById(s, second.principalTransactionId)).toMatchObject({
      accountId: s.walletId,
    })
    // The category the first instalment created is the one the second uses.
    const categories = await interestCategories(s)
    expect(categories).toHaveLength(1)
    expect((await transactionById(s, second.interestTransactionId)).categoryId).toBe(
      categories[0].id,
    )
    expect(await transactionCount(s)).toBe(5)
    expect(await balanceOf(s, s.bankId)).toBe('1910000')
    expect(await balanceOf(s, s.walletId)).toBe('5910000')
  })

  it('creates no "Loan Interest & Fees" category when no instalment carries interest', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 80_000,
      principalAmount: 80_000,
      interestAmount: 0,
      paymentDate: '2026-02-01',
    })

    await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      fakeProvider().provider,
    )

    expect(await transactionCount(s)).toBe(2)
    expect(await interestCategories(s)).toHaveLength(0)
  })

  it('links a closed loan too — the money did move — and keeps it closed', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
    })
    await closeLoan(s.userId, loan.id)

    const linked = await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      fakeProvider().provider,
    )

    expect(linked.status).toBe('CLOSED')
    expect(await transactionCount(s)).toBe(3)
    expect(await balanceOf(s, s.walletId)).toBe('5910000')
  })

  it('refuses a loan whose disbursement is already recorded, before any rate lookup, and writes nothing', async () => {
    const s = await setup()
    const loan = await createLoan(
      s.userId,
      { ...BASE_LOAN, accountId: s.bankId },
      fakeProvider().provider,
    )
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
    })
    await clearFxCache()

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
        failingProvider,
      ),
    ).rejects.toThrow(LoanAlreadyLinkedError)

    expect(await transactionCount(s)).toBe(1)
    expect((await paymentsOf(s, loan.id))[0].principalTransactionId).toBeNull()
  })

  it('lets exactly one of two concurrent links through; the other is refused under the lock', async () => {
    const s = await setup()
    const { provider } = fakeProvider()
    for (const run of [1, 2, 3]) {
      const loan = await createLoan(s.userId, { ...BASE_LOAN, lender: `Race ${run}` })

      const results = await Promise.allSettled([
        linkLoanToAccount(
          s.userId,
          loan.id,
          { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
          provider,
        ),
        linkLoanToAccount(
          s.userId,
          loan.id,
          { accountId: s.bankId, disbursedOn: '2026-01-01', includePayments: true },
          provider,
        ),
      ])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((r) => r.status === 'rejected')
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(LoanAlreadyLinkedError)
      expect(
        await prisma.transaction.count({
          where: { userId: s.userId, note: { contains: `Race ${run}` } },
        }),
      ).toBe(1)
    }
  }, 30_000)

  it('refuses an account in another currency and writes nothing', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.dollarsId, disbursedOn: '2026-01-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toThrow(LinkedAccountCurrencyMismatchError)

    expect(await transactionCount(s)).toBe(0)
    expect((await loanById(s, loan.id)).disbursementTransactionId).toBeNull()
  })

  it('refuses an archived account and writes nothing', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.archivedId, disbursedOn: '2026-01-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toThrow(ArchivedAccountError)

    expect(await transactionCount(s)).toBe(0)
  })

  it('writes nothing when no usable rate exists', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
        failingProvider,
      ),
    ).rejects.toThrow(FxUnavailableError)

    expect(await transactionCount(s)).toBe(0)
    expect((await loanById(s, loan.id)).disbursementTransactionId).toBeNull()
  })

  it("refuses another user's loan and another user's account with P2025, writing nothing for either user", async () => {
    const s = await setup()
    const other = await setup()
    const mine = await createLoan(s.userId, BASE_LOAN)
    const theirs = await createLoan(other.userId, BASE_LOAN)
    const { provider } = fakeProvider()

    await expectPrismaCode(
      linkLoanToAccount(
        s.userId,
        theirs.id,
        { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
        provider,
      ),
      'P2025',
    )
    await expectPrismaCode(
      linkLoanToAccount(
        s.userId,
        mine.id,
        { accountId: other.walletId, disbursedOn: '2026-01-01', includePayments: true },
        provider,
      ),
      'P2025',
    )

    expect(await transactionCount(s)).toBe(0)
    expect(await transactionCount(other)).toBe(0)
    expect((await loanById(other, theirs.id)).disbursementTransactionId).toBeNull()
  })

  it('rolls everything back — the interest category included — when a write after the linked transactions fails', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
    })
    const failure = failInsideTransaction('loan', 'update')

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
        fakeProvider().provider,
      ),
    ).rejects.toBe(failure)

    vi.restoreAllMocks()
    expect(await transactionCount(s)).toBe(0)
    expect(await interestCategories(s)).toHaveLength(0)
    expect((await loanById(s, loan.id)).disbursementTransactionId).toBeNull()
    expect((await paymentsOf(s, loan.id))[0]).toMatchObject({
      principalTransactionId: null,
      interestTransactionId: null,
    })
    expect(await balanceOf(s, s.walletId)).toBe('5000000')
  })

  it('is what the Loans page reads afterwards: the loan and its instalments carry the account', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN)
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-02-01',
    })

    await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      fakeProvider().provider,
    )

    const [row] = await listLoans(s.userId)
    expect(row.disbursementTransaction?.accountId).toBe(s.walletId)
    expect(row.payments[0].principalTransaction?.accountId).toBe(s.walletId)
    expect(row.payments[0].interestTransaction?.accountId).toBe(s.walletId)
  })
})
