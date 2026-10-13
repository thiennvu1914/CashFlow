import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { prisma } from '@/lib/prisma'
import { resetFxMemoForTests } from '@/lib/currency/fx-service'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import {
  calendarDateToUtcCarrier,
  formatCalendarDate,
  todayCalendarDateInZone,
} from '@/lib/datetime/calendar-date'
import {
  createDebt,
  linkDebtToAccount,
  recordDebtPayment,
  updateDebtPayment,
  type DebtLinkContext,
} from './debt'
import {
  createLoan,
  linkLoanToAccount,
  recordLoanPayment,
  updateLoanPayment,
  type LoanLinkContext,
} from './loan'

/**
 * Ruling P12 (final review F8): money recorded in an account cannot have moved
 * later than today in the user's zone — a debt opening, a debt repayment, a
 * loan disbursement (its start date), a loan instalment, and "Record in an
 * account" (its date, and every existing payment it records). Recorded on a
 * later day, the agreement's figures would change at once while the account's
 * balance moved only on that day. Without an account nothing moves, and the
 * dates keep their usual rules.
 *
 * The services hold this whatever the caller sent: each parses its input
 * against the user's today, computed from the context's zone at the moment of
 * the call. "Later" here is two days ahead, clear of a run that crosses
 * midnight in that zone.
 */

const TIMEZONE = 'Asia/Ho_Chi_Minh'
const DEBT_CONTEXT: DebtLinkContext = { timezone: TIMEZONE, locale: 'vi' }
const LOAN_CONTEXT: LoanLinkContext = { timezone: TIMEZONE, locale: 'vi' }

const DAY_MS = 24 * 60 * 60 * 1000
const LATER = formatCalendarDate(
  new Date(calendarDateToUtcCarrier(todayCalendarDateInZone(TIMEZONE)).getTime() + 2 * DAY_MS),
)

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

const INSTALMENT = { totalAmount: 90_000, principalAmount: 80_000, interestAmount: 10_000 }

const createdUserIds: string[] = []
let fetchSpy: MockInstance

const provider: ExchangeRateProvider = {
  getLatestRate: async () => ({
    rate: 25000,
    effectiveDate: new Date(),
    fetchedAt: new Date(Date.now() - 60_000),
    source: 'future-dates-fake',
  }),
  getHistoricalRate: async () => null,
}

async function clearFxCache() {
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  resetFxMemoForTests()
}

/** A user with one VND wallet of 5,000,000. */
async function setup() {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `future-dates-${randomUUID()}@example.com`,
      name: 'Future Dates Test',
      emailVerified: false,
      timezone: TIMEZONE,
    },
  })
  createdUserIds.push(user.id)
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const wallet = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('5000000'),
      currency: 'VND',
    },
  })
  return { userId: user.id, walletId: wallet.id }
}

type Setup = Awaited<ReturnType<typeof setup>>

function transactionCount(s: Setup) {
  return prisma.transaction.count({ where: { userId: s.userId } })
}

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in test')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await clearFxCache()
})

afterEach(async () => {
  const fetchCalls = fetchSpy.mock.calls.length
  vi.restoreAllMocks()
  const userIds = createdUserIds.splice(0)
  try {
    await clearFxCache()
    if (userIds.length > 0) {
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

describe('debts', () => {
  it('refuses a debt lent from an account on a later day, and writes nothing', async () => {
    const s = await setup()

    await expect(
      createDebt(
        s.userId,
        { ...BASE_DEBT, accountId: s.walletId, movedOn: LATER },
        DEBT_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)

    expect(await prisma.debt.count({ where: { userId: s.userId } })).toBe(0)
    expect(await transactionCount(s)).toBe(0)
  })

  it('refuses a repayment into an account on a later day, but notes one in no account', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT, DEBT_CONTEXT)

    await expect(
      recordDebtPayment(
        s.userId,
        debt.id,
        { amount: 100_000, date: LATER, accountId: s.walletId },
        DEBT_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)
    expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(0)

    // "Don't record in an account": nothing moves, so a planned date is fine.
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: LATER }, DEBT_CONTEXT)
    expect(await prisma.debtPayment.count({ where: { userId: s.userId } })).toBe(1)
    expect(await transactionCount(s)).toBe(0)
  })

  it('refuses moving a repayment recorded in an account to a later day', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT, DEBT_CONTEXT)
    const payment = await recordDebtPayment(
      s.userId,
      debt.id,
      { amount: 100_000, date: '2026-03-05', accountId: s.walletId },
      DEBT_CONTEXT,
      provider,
    )

    await expect(
      updateDebtPayment(
        s.userId,
        payment.id,
        { amount: 100_000, date: LATER, accountId: s.walletId },
        DEBT_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)

    const stored = await prisma.debtPayment.findUniqueOrThrow({
      where: { userId_id: { userId: s.userId, id: payment.id } },
    })
    expect(formatCalendarDate(stored.date)).toBe('2026-03-05')
  })

  it('refuses "Record in an account" on a later day', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT, DEBT_CONTEXT)

    await expect(
      linkDebtToAccount(
        s.userId,
        debt.id,
        { accountId: s.walletId, openedOn: LATER, includePayments: false },
        DEBT_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)
    expect(await transactionCount(s)).toBe(0)
  })

  it('skips a later-dated payment with "Record in an account", recording the opening and the earlier payment', async () => {
    const s = await setup()
    const debt = await createDebt(s.userId, BASE_DEBT, DEBT_CONTEXT)
    await recordDebtPayment(
      s.userId,
      debt.id,
      { amount: 100_000, date: '2026-03-05' },
      DEBT_CONTEXT,
    )
    await recordDebtPayment(s.userId, debt.id, { amount: 100_000, date: LATER }, DEBT_CONTEXT)

    await linkDebtToAccount(
      s.userId,
      debt.id,
      { accountId: s.walletId, openedOn: '2026-03-01', includePayments: true },
      DEBT_CONTEXT,
      provider,
    )

    // The opening and the 5 March payment; the later one has no transaction.
    expect(await transactionCount(s)).toBe(2)
    const payments = await prisma.debtPayment.findMany({
      where: { userId: s.userId, debtId: debt.id },
      orderBy: { date: 'asc' },
    })
    expect(payments.map((payment) => payment.transactionId !== null)).toEqual([true, false])
  })
})

describe('loans', () => {
  it('refuses a loan received into an account with a later start date, and writes nothing', async () => {
    const s = await setup()

    await expect(
      createLoan(
        s.userId,
        { ...BASE_LOAN, startDate: LATER, nextDueDate: LATER, accountId: s.walletId },
        LOAN_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)

    expect(await prisma.loan.count({ where: { userId: s.userId } })).toBe(0)
    expect(await transactionCount(s)).toBe(0)
  })

  it('refuses an instalment paid from an account on a later day, but notes one in no account', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN, LOAN_CONTEXT)

    await expect(
      recordLoanPayment(
        s.userId,
        loan.id,
        { ...INSTALMENT, paymentDate: LATER, accountId: s.walletId },
        LOAN_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)
    expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(0)

    await recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, paymentDate: LATER }, LOAN_CONTEXT)
    expect(await prisma.loanPayment.count({ where: { userId: s.userId } })).toBe(1)
    expect(await transactionCount(s)).toBe(0)
  })

  it('refuses moving an instalment paid from an account to a later day', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN, LOAN_CONTEXT)
    const { payment } = await recordLoanPayment(
      s.userId,
      loan.id,
      { ...INSTALMENT, paymentDate: '2026-02-01', accountId: s.walletId },
      LOAN_CONTEXT,
      provider,
    )

    await expect(
      updateLoanPayment(
        s.userId,
        payment.id,
        { ...INSTALMENT, paymentDate: LATER, accountId: s.walletId },
        LOAN_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)
  })

  it('refuses "Record in an account" on a later day', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN, LOAN_CONTEXT)

    await expect(
      linkLoanToAccount(
        s.userId,
        loan.id,
        { accountId: s.walletId, disbursedOn: LATER, includePayments: false },
        LOAN_CONTEXT,
        provider,
      ),
    ).rejects.toThrow(ZodError)
    expect(await transactionCount(s)).toBe(0)
  })

  it('skips a later-dated instalment with "Record in an account", recording the disbursement and the earlier one', async () => {
    const s = await setup()
    const loan = await createLoan(s.userId, BASE_LOAN, LOAN_CONTEXT)
    await recordLoanPayment(
      s.userId,
      loan.id,
      { ...INSTALMENT, paymentDate: '2026-02-01' },
      LOAN_CONTEXT,
    )
    await recordLoanPayment(s.userId, loan.id, { ...INSTALMENT, paymentDate: LATER }, LOAN_CONTEXT)

    await linkLoanToAccount(
      s.userId,
      loan.id,
      { accountId: s.walletId, disbursedOn: '2026-01-01', includePayments: true },
      LOAN_CONTEXT,
      provider,
    )

    // The disbursement and the February instalment's two legs; nothing for the later one.
    expect(await transactionCount(s)).toBe(3)
    const payments = await prisma.loanPayment.findMany({
      where: { userId: s.userId, loanId: loan.id },
      orderBy: { paymentDate: 'asc' },
    })
    expect(payments.map((payment) => payment.principalTransactionId !== null)).toEqual([
      true,
      false,
    ])
  })
})
